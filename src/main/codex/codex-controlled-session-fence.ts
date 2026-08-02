import type { ControlledCodexSession } from './codex-controlled-session-acquisition'
import { isSameControlledLaunch } from './codex-controlled-session-launch'

type ControlledSessionFenceContext = {
  getCurrentSession: (conversationId: string) => ControlledCodexSession | undefined
  resolveCurrentAccountId: () => string | null
  resolveCurrentAccountRevision?: () => number
  isProviderAvailable: () => boolean
}

export function createControlledSessionFence(
  session: ControlledCodexSession,
  context: ControlledSessionFenceContext
): () => boolean {
  const launch = { ...session.launch }
  const accountRevision = context.resolveCurrentAccountRevision?.()
  return () =>
    context.isProviderAvailable() &&
    !session.missing &&
    context.getCurrentSession(launch.conversationId) === session &&
    isSameControlledLaunch(session.launch, launch) &&
    context.resolveCurrentAccountId() === launch.accountId &&
    context.resolveCurrentAccountRevision?.() === accountRevision
}
