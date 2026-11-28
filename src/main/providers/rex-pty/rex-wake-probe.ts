import { rexPowerLifecycle, type RexWakeVerdict } from './rex-power-lifecycle'
import { matchesRexRootIdentity } from './rex-root-identity'
import { rexServerIdentity, verifyRexIdentity } from './rex-session-record'
import { rexTerminalProcess, rexTerminalSize } from './rex-rpc-schema'
import type { RexFreshSession } from './rex-fresh-session'

/** No ownership acquisition, input, resize, or process creation in a wake probe. */
export async function probeRexWake(session: RexFreshSession): Promise<RexWakeVerdict> {
  if (session.closing || session.lost || session.exitCode !== undefined) {
    return 'healthy'
  }
  const { record, control, data } = session
  const target = { session_id: record.sessionId, block_id: record.blockId, args: {} }
  const server = await control.call('server.status', {}, rexServerIdentity.parse)
  const state = await control.call(
    'com.superlogical.terminal.process',
    target,
    rexTerminalProcess.parse
  )
  verifyRexIdentity(record, server, state.child?.pid)
  if (state.last_exit) {
    return 'control-lost'
  }
  // Size ownership may belong to another live Rex client. It is not liveness.
  if (
    record.backend === 'rex-local' &&
    record.rootIdentity &&
    !(await matchesRexRootIdentity(record))
  ) {
    return 'control-lost'
  }
  const healthy = await data.probeWake()
  return session.data !== data || healthy ? 'healthy' : 'data-lost'
}

export function observeRexControl(
  session: RexFreshSession,
  lost: (retainControl: boolean) => void
): void {
  const unregister = rexPowerLifecycle.register(
    session,
    () => probeRexWake(session),
    (retainControl) => lost(retainControl && !session.control.isClosed)
  )
  session.control.onClosed(() => {
    unregister()
    if (!session.closing && session.exitCode === undefined) {
      lost(false)
    }
  })
}

export async function readRexAppliedSize(
  session: RexFreshSession | undefined
): Promise<{ cols: number; rows: number } | null> {
  if (!session || session.lost || session.closing) {
    return null
  }
  try {
    const size = await session.control.call(
      'com.superlogical.terminal.size',
      { session_id: session.sessionId, block_id: session.blockId, args: {} },
      rexTerminalSize.parse
    )
    return { cols: size.columns, rows: size.rows }
  } catch {
    return null
  }
}
