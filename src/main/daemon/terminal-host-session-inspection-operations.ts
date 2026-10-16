import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'
import type { PtyJobTerminationReport } from '../windows/windows-pty-job-termination-report'

// Why null-not-throw: fetched for the tab-bar icon, so a vanished pane quietly yields "no agent".
export function getTerminalHostForegroundProcess(session: Session | undefined): string | null {
  return session?.isAlive ? session.getForegroundProcess() : null
}

export async function terminateTerminalHostPtyJob(
  session: Session | undefined
): Promise<PtyJobTerminationReport> {
  const report = session?.isAlive
    ? session.job.terminatePtyJobAndReport?.({ wslDistro: session.wslDistro })
    : undefined
  return (await report) ?? { terminated: false }
}

/** Reads every Session, even after a live one, to preserve the inventory's error order. */
export function hasLiveTerminalHostSessions(sessions: Iterable<Session>): boolean {
  let hasLive = false
  for (const session of sessions) {
    hasLive = session.isAlive || hasLive
  }
  return hasLive
}

export async function confirmTerminalHostForegroundProcess(
  session: Session | undefined
): Promise<string | null> {
  if (!session || !session.isAlive) {
    return null
  }
  return session.confirmForegroundProcess()
}

export async function confirmTerminalHostShellForeground(
  session: Session | undefined,
  currentSession: () => Session | undefined
): Promise<boolean> {
  if (session?.isAlive !== true) {
    return false
  }
  const confirmed = await session.confirmShellForeground()
  return confirmed && currentSession() === session && session.isAlive
}

export function getTerminalHostSnapshot(
  session: Session | undefined,
  opts: { scrollbackRows?: number }
): TerminalSnapshot | null {
  if (!session || !session.isAlive) {
    return null
  }
  return session.getSnapshot(opts)
}

export async function getSettledTerminalHostSnapshot(
  session: Session | undefined,
  opts: { scrollbackRows?: number }
): Promise<TerminalSnapshot | null> {
  if (!session || !session.isAlive) {
    return null
  }
  await session.settleShellOwnershipConfirmation()
  return session.getSnapshot(opts)
}

export function getTerminalHostPartialEscapeTail(session: Session | undefined): string {
  if (!session || !session.isAlive) {
    return ''
  }
  return session.getPartialEscapeTailAnsi()
}

export function getTerminalHostAppliedSize(
  session: Session | undefined
): { cols: number; rows: number } | null {
  if (!session || !session.isAlive) {
    return null
  }
  return session.getAppliedSize()
}

export function takeTerminalHostPendingOutput(
  session: Session | undefined,
  includeSnapshot: boolean,
  opts: { teardownSnapshot?: boolean }
): TakePendingOutputResult | null {
  if (!session || !session.isAlive) {
    return null
  }
  return session.takePendingOutput(includeSnapshot, opts)
}
