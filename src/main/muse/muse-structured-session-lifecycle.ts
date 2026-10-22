import type { MspLiveSession } from './muse-structured-live-session'

export type MspCancelTurnInput = {
  sessionId: string
  turnId?: string
  resolveLiveTurnId?: () => string | null
}

export function handleMspExit(
  context: MspLifecycleContext,
  sessionId: string,
  generation: string,
  requested: boolean
): void {
  const live = context.sessions.get(sessionId)
  if (!live || live.acquisitionGeneration !== generation || live.ended) {
    return
  }
  live.ended = true
  live.msp.markEnded()
  if (live.turnId) {
    live.translator.failTurn(live.turnId, requested ? 'closed' : 'exited')
    live.turnId = null
  }
  live.onEvent({
    type: 'ended',
    sessionId,
    reason: requested ? 'Muse session closed by Orca' : 'muse serve exited',
    cause: requested ? 'requested-close' : 'unexpected-exit',
    fence: live.fence,
    acquisitionGeneration: live.acquisitionGeneration
  })
}

export async function cancelMspTurn(
  live: MspLiveSession,
  input: MspCancelTurnInput
): Promise<{ cancelled: boolean; refusal?: { turnNotRunning: true } }> {
  const liveTurnId = input.resolveLiveTurnId?.() ?? live.turnId ?? live.msp.openTurnId
  if (input.turnId !== undefined && liveTurnId !== null && input.turnId !== liveTurnId) {
    return { cancelled: false, refusal: { turnNotRunning: true } }
  }
  if (!live.msp.running && liveTurnId === null) {
    return { cancelled: false, refusal: { turnNotRunning: true } }
  }
  try {
    await live.msp.interruptTurn(liveTurnId ?? undefined)
  } catch {
    return { cancelled: false, refusal: { turnNotRunning: true } }
  }
  if (liveTurnId) {
    live.translator.failTurn(liveTurnId, 'interrupted')
    live.turnId = null
    live.pendingTurn = null
  }
  for (const [itemId, ref] of live.prompts) {
    live.translator.resolvePromptRow(itemId, ref.turnId, {
      state: 'cancelled',
      selectedOptionId: null
    })
    live.prompts.delete(itemId)
  }
  return { cancelled: true }
}

export type MspLifecycleContext = {
  sessions: Map<string, MspLiveSession>
  onExit: (sessionId: string, generation: string, requested: boolean) => void
}

export async function stopMspSession(
  context: MspLifecycleContext,
  sessionId: string,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<boolean> {
  const live = context.sessions.get(sessionId)
  if (!live) {
    return true
  }
  live.closeRequested = true
  live.msp.markEnded()
  await live.client.close(signal).catch(() => undefined)
  const exited = !live.client.alive
  if (exited) {
    context.onExit(sessionId, live.acquisitionGeneration, true)
  }
  return exited
}

export function holdsMspDispatch(context: MspLifecycleContext, sessionId: string): boolean {
  return context.sessions.get(sessionId)?.msp.running ?? false
}

export function heldMspSends(
  context: MspLifecycleContext,
  sessionId: string
): ReadonlySet<string> | undefined {
  const pending = context.sessions.get(sessionId)?.pendingTurn
  return pending ? new Set([pending.clientMessageId]) : undefined
}

export function holdsMspProcess(
  context: MspLifecycleContext,
  sessionId: string,
  acquisitionGeneration: string
): boolean {
  const live = context.sessions.get(sessionId)
  return live?.acquisitionGeneration === acquisitionGeneration && !live.ended && live.client.alive
}

export function acknowledgeMspRelease(context: MspLifecycleContext, sessionId: string): void {
  if (context.sessions.get(sessionId)?.ended) {
    context.sessions.delete(sessionId)
  }
}

export async function closeAllMspSessions(context: MspLifecycleContext): Promise<void> {
  await Promise.all(
    [...context.sessions.keys()].map((sessionId) => stopMspSession(context, sessionId, 'SIGKILL'))
  )
}
