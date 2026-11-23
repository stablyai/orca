import { OVERLONG_JSON_STRING, scanOversizedJsonObject } from './claude-oversized-json-object'

const HEADER_BYTES = 1024
const MAX_FIELD_CHARS = 256
const MAX_PENDING_REQUESTS = 32
const MAX_KEY_CHARS = 'pending_permission_requests'.length

const FRAME_TYPE = /^[ \t\r]*\{[ \t\r]*"type"[ \t\r]*:[ \t\r]*"([\w-]+)"/
const SYSTEM_SUBTYPE = /^[ \t\r]*,[ \t\r]*"subtype"[ \t\r]*:[ \t\r]*"([\w-]+)"/
const REQUEST_SUBTYPE =
  /^[ \t\r]*,[ \t\r]*(?:"request_id"[ \t\r]*:[ \t\r]*"(?:[^"\\]|\\.)*"[ \t\r]*,[ \t\r]*)?"request"[ \t\r]*:[ \t\r]*\{[ \t\r]*"subtype"[ \t\r]*:[ \t\r]*"([\w-]+)"/

type Fields = Record<string, Field>
type Field = true | { object: Fields } | { items: Fields }
type Projection = { depth: number } & (
  | { fields: Fields; key?: string; value: Record<string, unknown> }
  | { items: Fields; value: unknown[] }
)

const REQUEST_FIELDS: Fields = {
  type: true,
  request_id: true,
  request: { object: { subtype: true } }
}
const RESPONSE_FIELDS: Fields = {
  type: true,
  response: {
    object: {
      subtype: true,
      request_id: true,
      response: { object: { current_permission_mode: true, mode: true } },
      pending_permission_requests: { items: REQUEST_FIELDS }
    }
  }
}
const REPORT_FIELDS: Fields = {
  type: true,
  subtype: true,
  session_id: true,
  parent_tool_use_id: true,
  permissionMode: true
}
const UNKNOWN_FRAME_FIELDS: Fields = { ...REPORT_FIELDS, ...REQUEST_FIELDS, ...RESPONSE_FIELDS }
const AMBIGUOUS = Symbol('repeated JSON key')

type FrameKind = 'report' | 'request' | 'response' | 'unknown'

function permissionFrameKind(header: string): FrameKind | undefined {
  const type = FRAME_TYPE.exec(header)
  if (!type) {
    return 'unknown'
  }
  switch (type[1]) {
    case 'system': {
      const subtype = SYSTEM_SUBTYPE.exec(header.slice(type[0].length))?.[1]
      return subtype === undefined || subtype === 'init' || subtype === 'status'
        ? 'report'
        : undefined
    }
    case 'control_request': {
      const subtype = REQUEST_SUBTYPE.exec(header.slice(type[0].length))?.[1]
      return subtype === undefined || subtype === 'can_use_tool' ? 'request' : undefined
    }
    case 'control_response':
      return 'response'
    default:
      return undefined
  }
}

function couldBeRootModeReport(frame: Record<string, unknown>, sessionId: string): boolean {
  return (
    (frame.type === 'system' || frame.type === AMBIGUOUS || frame.type === OVERLONG_JSON_STRING) &&
    (frame.subtype === 'init' ||
      frame.subtype === 'status' ||
      frame.subtype === AMBIGUOUS ||
      frame.subtype === OVERLONG_JSON_STRING) &&
    (typeof frame.session_id !== 'string' || frame.session_id === sessionId) &&
    typeof frame.parent_tool_use_id !== 'string' &&
    frame.parent_tool_use_id !== OVERLONG_JSON_STRING &&
    Object.hasOwn(frame, 'permissionMode')
  )
}

/** A null result invalidates the running mode; undefined means the frame gave no evidence. */
export function scanClaudeOversizedPermissionFrame(
  chunk: Buffer,
  start: number,
  end: number,
  authorizeFullAccess: boolean,
  awaitingReply: boolean,
  sessionId: string
) {
  // The CLI leads with type and subtype, so ordinary frames bypass the tokenizer.
  const kind = permissionFrameKind(
    chunk.toString('utf8', start, Math.min(end, start + HEADER_BYTES))
  )
  if (
    kind === undefined ||
    (kind === 'request' && !authorizeFullAccess) ||
    (kind === 'response' && !authorizeFullAccess && !awaitingReply)
  ) {
    return undefined
  }
  const fields = {
    report: REPORT_FIELDS,
    request: REQUEST_FIELDS,
    response: RESPONSE_FIELDS,
    unknown: UNKNOWN_FRAME_FIELDS
  }[kind]
  const root: Record<string, unknown> = Object.create(null)
  const projections: Projection[] = []
  let readable = true

  const parentAt = (depth: number): Projection | undefined => {
    const parent = projections.at(-1)
    return parent?.depth === depth - 1 ? parent : undefined
  }

  const fieldAt = (parent: Projection | undefined): Field | undefined =>
    parent && 'fields' in parent && parent.key !== undefined ? parent.fields[parent.key] : undefined

  const assign = (parent: Projection | undefined, value: unknown): boolean => {
    if (!parent) {
      return false
    }
    if ('items' in parent) {
      if (parent.value.length === MAX_PENDING_REQUESTS) {
        readable = false
        return false
      }
      parent.value.push(value)
      return true
    }
    if (parent.key === undefined) {
      return false
    }
    parent.value[parent.key] = value
    parent.key = undefined
    return true
  }

  const scan = scanOversizedJsonObject({
    stringLimit(depth, key) {
      const parent = parentAt(depth)
      return key
        ? parent && 'fields' in parent
          ? MAX_KEY_CHARS
          : 0
        : fieldAt(parent) === true
          ? MAX_FIELD_CHARS
          : 0
    },
    key(depth, key) {
      const parent = parentAt(depth)
      if (
        !parent ||
        !('fields' in parent) ||
        typeof key !== 'string' ||
        !Object.hasOwn(parent.fields, key)
      ) {
        return
      }
      if (Object.hasOwn(parent.value, key)) {
        parent.value[key] = AMBIGUOUS
        readable = false
      } else {
        parent.key = key
      }
    },
    value(depth, value) {
      if (value === OVERLONG_JSON_STRING) {
        readable = false
      }
      assign(parentAt(depth), value)
    },
    open(depth, array) {
      if (depth === 0) {
        projections.push({ depth, fields, value: root })
        return
      }
      const parent = parentAt(depth)
      const shape = parent && 'items' in parent ? { object: parent.items } : fieldAt(parent)
      let next: Projection | undefined
      if (shape && shape !== true) {
        if (!array && 'object' in shape) {
          next = { depth, fields: shape.object, value: Object.create(null) }
        } else if (array && 'items' in shape) {
          next = { depth, items: shape.items, value: [] }
        }
      }
      if (assign(parent, next?.value ?? null) && next) {
        projections.push(next)
      }
    },
    close(depth) {
      if (projections.at(-1)?.depth === depth) {
        projections.pop()
      }
    }
  })

  return {
    write: scan.write,
    finish(): Record<string, unknown> | null | undefined {
      if (!scan.finish()) {
        // A broken candidate report could hide attribution or a mode later in the frame.
        return kind === 'report' || kind === 'unknown' ? null : undefined
      }
      if (!readable) {
        return couldBeRootModeReport(root, sessionId) ? null : undefined
      }
      return root
    }
  }
}
