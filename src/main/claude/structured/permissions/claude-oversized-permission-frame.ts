import { StringDecoder } from 'node:string_decoder'
import exec from 'stream-chain/exec.js'
import { none } from 'stream-chain/defs.js'
import parser, { type Token } from 'stream-json/core/parser.js'
import { ownRetainedString } from '../../../../shared/text/own-retained-string'

const SCAN_BATCH_BYTES = 1024
const MAX_NESTING_DEPTH = 64
const MAX_REPORT_FIELD_CHARS = 256
const MAX_KEY_CHARS = 'pending_permission_requests'.length

type Fields = Record<string, Field>
type Field = true | { object: Fields } | { items: Fields }
type Projection =
  | { fields: Fields; key: string; value: Record<string, unknown> }
  | { items: Fields; value: unknown[] }

const REQUEST_FIELDS: Fields = {
  type: true,
  request_id: true,
  request: { object: { subtype: true } }
}
const CONTROL_FIELDS: Fields = {
  ...REQUEST_FIELDS,
  response: {
    object: {
      subtype: true,
      request_id: true,
      response: { object: { current_permission_mode: true } },
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

/** Project only the given JSON paths, including fields read before a control prefix ends. */
function scanFields(fields: Fields, scalarLimit: number, maxDepth: number) {
  const decoder = new StringDecoder('utf8')
  const parse = exec(parser({ packValues: false }))
  const stack: (Projection | undefined)[] = []
  let root: Record<string, unknown> | undefined
  let valid = true
  let scalar = ''
  let limit = 0
  let truncated = false

  const selectedField = (parent: Projection | undefined): Field | undefined =>
    parent && 'fields' in parent && Object.hasOwn(parent.fields, parent.key)
      ? parent.fields[parent.key]
      : undefined

  const assign = (parent: Projection | undefined, value: unknown): void => {
    if (parent && 'fields' in parent && selectedField(parent)) {
      parent.value[parent.key] = value
    } else if (parent && 'items' in parent && value !== null) {
      parent.value.push(value)
    }
  }

  const consume = (token: Token): void => {
    const parent = stack.at(-1)
    switch (token.name) {
      case 'startObject':
      case 'startArray': {
        if (stack.length === maxDepth) {
          throw new RangeError('Oversized Claude frame exceeds the scan depth')
        }
        const shape =
          stack.length === 0
            ? { object: fields }
            : parent && 'items' in parent
              ? { object: parent.items }
              : selectedField(parent)
        let next: Projection | undefined
        if (shape && shape !== true) {
          if (token.name === 'startObject' && 'object' in shape) {
            next = { fields: shape.object, key: '', value: Object.create(null) }
            if (stack.length === 0) {
              root = next.value
            }
          } else if (token.name === 'startArray' && 'items' in shape) {
            next = { items: shape.items, value: [] }
          }
        }
        assign(parent, next?.value ?? null)
        stack.push(next)
        break
      }
      case 'endObject':
      case 'endArray':
        stack.pop()
        break
      case 'startKey':
      case 'startString':
        scalar = ''
        limit =
          token.name === 'startKey'
            ? parent && 'fields' in parent
              ? MAX_KEY_CHARS
              : 0
            : selectedField(parent) === true
              ? scalarLimit
              : 0
        truncated = false
        break
      case 'stringChunk':
        if (limit && !truncated) {
          truncated = scalar.length + token.value.length > limit
          scalar = truncated ? '' : scalar + token.value
        }
        break
      case 'endKey':
        if (parent && 'fields' in parent) {
          parent.key = scalar
          if (selectedField(parent)) {
            delete parent.value[scalar]
          }
        }
        break
      case 'endString':
        if (parent && 'fields' in parent && selectedField(parent) === true) {
          // Even a long parent string identifies a child. A long mode is an unknown mode.
          parent.value[parent.key] =
            truncated && parent.key === 'permissionMode' ? 'unknown' : ownRetainedString(scalar)
        } else {
          assign(parent, null)
        }
        break
      case 'endNumber':
      case 'trueValue':
      case 'falseValue':
      case 'nullValue':
        assign(parent, null)
        break
    }
  }

  const feed = (input: string | typeof none): void => {
    try {
      parse(input, consume)
    } catch {
      valid = false
    }
  }

  return {
    write(chunk: Buffer, start: number, end: number): void {
      for (let offset = start; valid && offset < end; offset += SCAN_BATCH_BYTES) {
        feed(decoder.write(chunk.subarray(offset, Math.min(end, offset + SCAN_BATCH_BYTES))))
      }
    },
    prefix: () => (valid ? root : undefined),
    finish(): Record<string, unknown> | undefined {
      if (valid) {
        feed(decoder.end())
        if (valid) {
          feed(none)
        }
      }
      return valid && stack.length === 0 ? root : undefined
    }
  }
}

export function readClaudePermissionControlPrefix(chunk: Buffer, bytes: number) {
  const scan = scanFields(CONTROL_FIELDS, bytes, bytes)
  scan.write(chunk, 0, bytes)
  return scan.prefix()
}

export function scanClaudePermissionReport() {
  return scanFields(REPORT_FIELDS, MAX_REPORT_FIELD_CHARS, MAX_NESTING_DEPTH)
}
