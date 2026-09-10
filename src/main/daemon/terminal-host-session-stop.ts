import type { Session } from './session'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { TerminalHostTombstones } from './terminal-host-tombstones'
import type { WindowsPtyJobObjectReceiptHandoff } from '../providers/windows-pty-job-object'

export function stopTerminalHostSession(
  sessionId: string,
  opts: { immediate?: boolean; expectedIncarnationId?: string },
  context: {
    sessionTeardown: TerminalSessionTeardown
    windowsJobReceiptHandoff: WindowsPtyJobObjectReceiptHandoff
    killedTombstones: TerminalHostTombstones
    getAliveSession: (id: string) => Session
  }
) {
  const { sessionTeardown, windowsJobReceiptHandoff, killedTombstones, getAliveSession } = context
  const pending = sessionTeardown.get(sessionId)
  if (pending) {
    const receipt = opts.immediate ? sessionTeardown.requestImmediate(sessionId) : pending
    if (!receipt) {
      return Promise.reject(new Error('pty_stop_receipt_unavailable'))
    }
    return windowsJobReceiptHandoff.resolve(sessionId, receipt, opts.expectedIncarnationId)!
  }
  const replay =
    windowsJobReceiptHandoff.resolve(sessionId, null, opts.expectedIncarnationId) ??
    sessionTeardown.getReceipt(sessionId, opts)
  if (replay) {
    return Promise.resolve(replay)
  }
  const session = getAliveSession(sessionId)
  if (opts.expectedIncarnationId && session.incarnationId !== opts.expectedIncarnationId) {
    return Promise.reject(new Error('pty_stop_receipt_identity_mismatch'))
  }
  const killed = windowsJobReceiptHandoff.resolve(
    sessionId,
    sessionTeardown.killSession(sessionId, session, opts.immediate === true)
  )!
  killedTombstones.record(sessionId)
  void killed.catch(() => killedTombstones.clearForCreate(sessionId))
  return killed
}
