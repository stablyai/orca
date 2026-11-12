import { StringDecoder } from 'node:string_decoder'
import { isRootClaudeFrame } from './turns/claude-turn-opening'
import {
  readClaudeFrameString,
  readClaudeReportedPermissionMode
} from './claude-structured-init-proof'

export type ClaudeFullAccessPolicy = {
  /** Each raw stdout chunk, no later than the SDK reads it. */
  observe: (chunk: Buffer | string) => void
  /** Whether Claude still ran in Full access where this request appeared on the wire. */
  allows: (requestId: string) => boolean
  /** Claude's latest reported mode in wire order, decoded; undefined before its first report. */
  mode: () => string | null | undefined
  close: () => void
  retained: () => { partialChars: number; requests: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Granted only by a Full access launch; Claude's mode reports can suspend it, never create it.
 *  The SDK answers permission requests straight from its reader while ordinary frames queue
 *  behind Orca's pausable consumer, and a stdout chunk is read ahead of the requests in it,
 *  so each request keeps the mode in effect at its own position in the stream. */
export function createClaudeFullAccessPolicy(providerSessionId: string): ClaudeFullAccessPolicy {
  const decoder = new StringDecoder('utf8')
  // Kept until the SDK hands the request to canUseTool or the process ends; a cancel still
  // reaches the callback as an abort, so dropping its entry early would apply a later mode.
  const modeAtRequest = new Map<string, boolean>()
  let mode: string | null | undefined
  let closed = false
  let partial = ''

  const remember = (request: unknown): void => {
    if (
      !isRecord(request) ||
      request.type !== 'control_request' ||
      !isRecord(request.request) ||
      request.request.subtype !== 'can_use_tool'
    ) {
      return
    }
    const requestId = readClaudeFrameString(request, 'request_id')
    // A redelivered id keeps its first position.
    if (requestId && !modeAtRequest.has(requestId)) {
      modeAtRequest.set(requestId, mode === undefined || mode === 'full-access')
    }
  }

  const observeLine = (line: string): void => {
    // Each relevant key appears literally in its frame; anything else skips the parse.
    if (!line.includes('"permissionMode"') && !line.includes('"can_use_tool"')) {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(frame)) {
      return
    }
    if (frame.type === 'control_request') {
      remember(frame)
      return
    }
    if (frame.type === 'control_response') {
      // Initialize's reply resends requests still waiting for an answer.
      const pending = isRecord(frame.response) ? frame.response.pending_permission_requests : null
      for (const request of Array.isArray(pending) ? pending : []) {
        remember(request)
      }
      return
    }
    if (
      readClaudeFrameString(frame, 'session_id') !== providerSessionId ||
      !isRootClaudeFrame(frame)
    ) {
      return
    }
    // Absent keeps the last report; plan, ask, dontAsk and unknown modes all suspend Full access.
    const reported = readClaudeReportedPermissionMode(frame)
    if (reported !== undefined) {
      mode = reported
    }
  }

  return {
    observe: (chunk) => {
      if (closed) {
        return
      }
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      // Scan only the new text, so a line spanning many chunks costs its length once.
      let start = 0
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
        observeLine(partial + text.slice(start, end))
        partial = ''
        start = end + 1
      }
      partial += text.slice(start)
    },
    allows: (requestId) => {
      const atRequest = modeAtRequest.get(requestId)
      modeAtRequest.delete(requestId)
      // A request Orca never saw on the wire has no position, so it never inherits a later mode.
      return atRequest ?? false
    },
    mode: () => mode,
    close: () => {
      closed = true
      partial = ''
      modeAtRequest.clear()
    },
    retained: () => ({ partialChars: partial.length, requests: modeAtRequest.size })
  }
}
