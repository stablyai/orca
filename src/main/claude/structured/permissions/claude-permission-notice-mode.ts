import {
  readClaudeFrameString,
  readClaudeOpenedPermissionMode
} from '../startup/claude-structured-init-proof'

const MAX_PENDING_MODE_WRITES = 32
const NOTICE_MODES = ['auto', 'bypassPermissions'] as const
export type ClaudePermissionNoticeIntent = (typeof NOTICE_MODES)[number]

type PendingWrite = { position: number; mode: string }

export function createClaudePermissionNoticeMode(onChange: () => void) {
  const pending = new Map<string, PendingWrite>()
  const confirmed = new Set<string>()
  const refusals = new Set<string>()
  let initializing: string | undefined
  let closed = false
  let writtenThrough = 0
  let provenThrough = 0
  let evictedThrough = 0
  let provenMode: string | null | undefined
  let runningMode: string | undefined
  let unconfirmed = false

  const unresolvedWrite = (): boolean => {
    if (evictedThrough > provenThrough) {
      return true
    }
    for (const write of pending.values()) {
      if (write.position > provenThrough && write.mode !== provenMode) {
        return true
      }
    }
    return false
  }

  const updateRunning = (): boolean => {
    const uncertain = provenMode === null || unresolvedWrite()
    const running = uncertain ? undefined : (provenMode ?? undefined)
    if (running === runningMode && uncertain === unconfirmed) {
      return false
    }
    runningMode = running
    unconfirmed = uncertain
    onChange()
    return true
  }

  const prove = (mode: string, position: number): void => {
    provenMode = mode
    provenThrough = Math.max(provenThrough, position)
    const firstConfirmation = !confirmed.has(mode) && NOTICE_MODES.some((intent) => intent === mode)
    if (firstConfirmation) {
      confirmed.add(mode)
    }
    const clearedRefusal = refusals.delete(mode)
    if (!updateRunning() && (firstConfirmation || clearedRefusal)) {
      onChange()
    }
  }

  return {
    running: () => runningMode,
    unconfirmed: () => unconfirmed,
    hasRun: (mode: ClaudePermissionNoticeIntent) => confirmed.has(mode),
    refused: (mode: ClaudePermissionNoticeIntent) => refusals.has(mode),
    awaitingReply: () => initializing !== undefined || pending.size !== 0,
    write: (chunk: Buffer | string): void => {
      if (closed) {
        return
      }
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (!line.includes('"set_permission_mode"') && !line.includes('"initialize"')) {
        return
      }
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (!isRecord(frame) || frame.type !== 'control_request' || !isRecord(frame.request)) {
        return
      }
      const id = readClaudeFrameString(frame, 'request_id')
      if (!id) {
        return
      }
      if (frame.request.subtype === 'initialize') {
        initializing = id
      } else if (frame.request.subtype === 'set_permission_mode') {
        const mode = readClaudeFrameString(frame.request, 'mode')
        if (!mode || pending.has(id)) {
          return
        }
        if (pending.size === MAX_PENDING_MODE_WRITES) {
          for (const [oldestId, oldest] of pending) {
            evictedThrough = oldest.position
            pending.delete(oldestId)
            break
          }
        }
        pending.set(id, { mode, position: ++writtenThrough })
        updateRunning()
      }
    },
    report: (mode: string): void => {
      if (!closed) {
        prove(mode, writtenThrough)
      }
    },
    reportUnknown: (): void => {
      if (!closed) {
        provenMode = null
        updateRunning()
      }
    },
    reply: (response: unknown): void => {
      if (
        closed ||
        !isRecord(response) ||
        (response.subtype !== 'success' && response.subtype !== 'error')
      ) {
        return
      }
      const id = readClaudeFrameString(response, 'request_id')
      if (!id) {
        return
      }
      if (id === initializing) {
        initializing = undefined
        const mode =
          response.subtype === 'success' ? readClaudeOpenedPermissionMode(response.response) : null
        if (mode !== null) {
          prove(mode, writtenThrough)
        }
        return
      }
      const write = pending.get(id)
      if (!write) {
        return
      }
      pending.delete(id)
      if (response.subtype === 'success') {
        const payload = response.response
        const mode = isRecord(payload) ? readClaudeFrameString(payload, 'mode') : null
        prove(mode ?? write.mode, write.position)
      } else {
        const newRefusal =
          NOTICE_MODES.some((intent) => intent === write.mode) && !refusals.has(write.mode)
        if (newRefusal) {
          refusals.add(write.mode)
        }
        if (!updateRunning() && newRefusal) {
          onChange()
        }
      }
    },
    close: (): void => {
      closed = true
      pending.clear()
      confirmed.clear()
      refusals.clear()
      initializing = undefined
      provenMode = undefined
      runningMode = undefined
      unconfirmed = false
    }
  }
}

export type ClaudePermissionNoticeMode = ReturnType<typeof createClaudePermissionNoticeMode>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
