import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import {
  readClaudeFrameString,
  readClaudeReportedPermissionMode
} from '../startup/claude-structured-init-proof'
import {
  readClaudePermissionControlPrefix,
  scanClaudePermissionReport
} from './claude-oversized-permission-frame'
import type { ClaudePermissionNoticeMode } from './claude-permission-notice-mode'

const CLAUDE_STDOUT_PREFIX_BYTES = 64 * 1024
const STDOUT_STRING_BATCH_CHARS = 16 * 1024
const LEADING_FRAME_TYPE = /^[ \t\r]*\{[ \t\r]*"type"[ \t\r]*:[ \t\r]*"([\w-]+)"/

export type ClaudeFullAccessPolicy = {
  /** Each raw stdout chunk, no later than the SDK reads it. */
  observe: (chunk: Buffer | string) => void
  /** Whether Claude still ran in Full access where this request appeared on the wire. */
  allows: (requestId: string) => boolean
  /** Claude's latest reported mode in wire order, decoded; undefined before its first report. */
  mode: () => string | null | undefined
  close: () => void
  retained: () => { partialChars: number; partialBytes: number; requests: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Granted only by a Full access launch; Claude's mode reports can suspend it, never create it.
 *  The SDK answers permission requests straight from its reader while ordinary frames queue
 *  behind Orca's pausable consumer, and a stdout chunk is read ahead of the requests in it,
 *  so each request keeps the mode in effect at its own position in the stream. */
export function createClaudeFullAccessPolicy(
  providerSessionId: string,
  authorizeFullAccess = true,
  noticeMode?: ClaudePermissionNoticeMode
): ClaudeFullAccessPolicy {
  // Kept until the SDK hands the request to canUseTool or the process ends; a cancel still
  // reaches the callback as an abort, so dropping its entry early would apply a later mode.
  const modeAtRequest = authorizeFullAccess ? new Map<string, boolean>() : null
  let mode: string | null | undefined
  let closed = false
  let prefix: Buffer | undefined
  let prefixBytes = 0
  let oversized = false
  let reportScan: ReturnType<typeof scanClaudePermissionReport> | undefined
  let trailingHighSurrogate = ''

  const remember = (request: unknown): void => {
    if (
      !modeAtRequest ||
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

  const rememberPending = (response: unknown): void => {
    // Initialize's reply resends requests still waiting for an answer.
    const pending = isRecord(response) ? response.pending_permission_requests : null
    for (const request of Array.isArray(pending) ? pending : []) {
      remember(request)
    }
  }

  const observeReport = (frame: Record<string, unknown>): void => {
    if (
      readClaudeFrameString(frame, 'session_id') !== providerSessionId ||
      !isRootClaudeFrame(frame)
    ) {
      return
    }
    // Absent keeps the last report; plan, ask, dontAsk and unknown modes all suspend Full access.
    const reported = readClaudeReportedPermissionMode(frame)
    if (reported !== undefined) {
      if (authorizeFullAccess) {
        mode = reported
      }
      if (noticeMode && typeof frame.permissionMode === 'string') {
        noticeMode.report(frame.permissionMode)
      }
    }
  }

  const observeLine = (line: string): void => {
    // Each relevant key appears literally in its frame; anything else skips the parse.
    const report = line.includes('"permissionMode"')
    const tool = authorizeFullAccess && line.includes('"can_use_tool"')
    if (!report && !tool && !(noticeMode?.awaitingReply() && line.includes('"control_response"'))) {
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
    } else if (frame.type === 'control_response') {
      if (report || tool) {
        rememberPending(frame.response)
      }
      noticeMode?.reply(frame.response)
    } else {
      observeReport(frame)
    }
  }

  const clearLine = (): void => {
    prefix = undefined
    prefixBytes = 0
    oversized = false
    reportScan = undefined
  }

  const appendPrefix = (chunk: Buffer, start: number, end: number): void => {
    const required = prefixBytes + end - start
    if (!prefix || required > prefix.length) {
      const capacity = Math.min(
        CLAUDE_STDOUT_PREFIX_BYTES,
        Math.max(1024, (prefix?.length ?? 0) * 2, required)
      )
      const next = Buffer.allocUnsafe(capacity)
      prefix?.copy(next, 0, 0, prefixBytes)
      prefix = next
    }
    chunk.copy(prefix, prefixBytes, start, end)
    prefixBytes = required
  }

  const startOversizedLine = (): void => {
    oversized = true
    if (!prefix) {
      return
    }
    const type = LEADING_FRAME_TYPE.exec(
      prefix.toString('utf8', 0, Math.min(1024, prefixBytes))
    )?.[1]
    // The CLI leads with type. Scan through LF for reports since a child marker can follow the mode.
    if (type === undefined || type === 'system') {
      reportScan = scanClaudePermissionReport()
      reportScan.write(prefix, 0, prefixBytes)
    }
    if (
      (type !== undefined && type !== 'control_request' && type !== 'control_response') ||
      (!authorizeFullAccess && (type === 'control_request' || !noticeMode?.awaitingReply()))
    ) {
      prefix = undefined
      prefixBytes = 0
    }
  }

  const finishLine = (): void => {
    if (!oversized) {
      const line = prefix?.toString('utf8', 0, prefixBytes) ?? ''
      clearLine()
      observeLine(line)
      return
    }
    const report = reportScan?.finish()
    const control = prefix && readClaudePermissionControlPrefix(prefix, prefixBytes)
    clearLine()
    if (report?.type === 'system') {
      observeReport(report)
    } else if (control?.type === 'control_request') {
      remember(control)
    } else if (control?.type === 'control_response') {
      rememberPending(control.response)
      noticeMode?.reply(control.response)
    }
  }

  const observeBytes = (chunk: Buffer): void => {
    let start = 0
    while (!closed && start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.length : newline
      if (
        !oversized &&
        prefixBytes === 0 &&
        newline !== -1 &&
        end - start <= CLAUDE_STDOUT_PREFIX_BYTES
      ) {
        observeLine(chunk.toString('utf8', start, end))
      } else {
        if (!oversized) {
          const prefixEnd = Math.min(end, start + CLAUDE_STDOUT_PREFIX_BYTES - prefixBytes)
          if (prefixEnd > start) {
            appendPrefix(chunk, start, prefixEnd)
            start = prefixEnd
          }
          if (start < end) {
            startOversizedLine()
          }
        }
        reportScan?.write(chunk, start, end)
        if (newline !== -1) {
          finishLine()
        }
      }
      start = end + 1
    }
  }

  return {
    observe: (chunk) => {
      if (closed) {
        return
      }
      if (typeof chunk !== 'string') {
        if (trailingHighSurrogate) {
          observeBytes(Buffer.from(trailingHighSurrogate))
          trailingHighSurrogate = ''
        }
        observeBytes(chunk)
        return
      }
      for (let start = 0; !closed && start < chunk.length; start += STDOUT_STRING_BATCH_CHARS) {
        const text = trailingHighSurrogate + chunk.slice(start, start + STDOUT_STRING_BATCH_CHARS)
        const last = text.charCodeAt(text.length - 1)
        const splitSurrogate = last >= 0xd800 && last <= 0xdbff
        trailingHighSurrogate = splitSurrogate ? (text.at(-1) ?? '') : ''
        observeBytes(Buffer.from(splitSurrogate ? text.slice(0, -1) : text))
      }
    },
    allows: (requestId) => {
      const atRequest = modeAtRequest?.get(requestId)
      modeAtRequest?.delete(requestId)
      // A request Orca never saw on the wire has no position, so it never inherits a later mode.
      return atRequest ?? false
    },
    mode: () => mode,
    close: () => {
      closed = true
      clearLine()
      trailingHighSurrogate = ''
      modeAtRequest?.clear()
      noticeMode?.close()
    },
    retained: () => ({
      partialChars: prefix?.toString('utf8', 0, prefixBytes).length ?? 0,
      partialBytes: prefix?.length ?? 0,
      requests: modeAtRequest?.size ?? 0
    })
  }
}
