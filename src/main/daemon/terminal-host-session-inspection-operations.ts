import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

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
