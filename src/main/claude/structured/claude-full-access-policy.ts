import { StringDecoder } from 'node:string_decoder'
import { isRootClaudeFrame } from '../claude-turn-opening'
import {
  readClaudeFrameString,
  readClaudeReportedPermissionMode
} from './claude-structured-init-proof'

/** Backstop for requests the SDK never hands to canUseTool; live asks number a handful. */
const MAX_PENDING_REQUESTS = 256

export type ClaudeFullAccessPolicy = {
  /** Each raw stdout chunk, no later than the SDK reads it. */
  observe: (chunk: Buffer | string) => void
  /** Whether Claude still ran in Full access where this request appeared on the wire. */
  allows: (requestId: string) => boolean
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
  const modeAtRequest = new Map<string, boolean>()
  let fullAccess = true
  let partial = ''

  const observeLine = (line: string): void => {
    // Each relevant key appears literally in its frame; anything else skips the parse.
    if (
      !line.includes('"permissionMode"') &&
      !line.includes('"can_use_tool"') &&
      !line.includes('"control_cancel_request"')
    ) {
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
    const requestId = readClaudeFrameString(frame, 'request_id')
    if (frame.type === 'control_request') {
      if (requestId && isRecord(frame.request) && frame.request.subtype === 'can_use_tool') {
        const oldest = modeAtRequest.keys().next()
        if (modeAtRequest.size >= MAX_PENDING_REQUESTS && !oldest.done) {
          modeAtRequest.delete(oldest.value)
        }
        modeAtRequest.set(requestId, fullAccess)
      }
      return
    }
    if (frame.type === 'control_cancel_request') {
      if (requestId) {
        modeAtRequest.delete(requestId)
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
      fullAccess = reported === 'full-access'
    }
  }

  return {
    observe: (chunk) => {
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
      return atRequest ?? fullAccess
    },
    close: () => {
      fullAccess = false
      partial = ''
      modeAtRequest.clear()
    },
    retained: () => ({ partialChars: partial.length, requests: modeAtRequest.size })
  }
}
