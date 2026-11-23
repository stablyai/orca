import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { botOfSession } from './bot-session-tabs'
import { startedForBot } from '../runtime/rpc/methods/orchestration/worker/start/worker-keep-open-default'
import { resolveStructuredWorkerIdentityForSession } from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-authority'

export function botRequiresFullAccess(runtime: OrcaRuntimeService, botId: string): boolean {
  return runtime.requireStore().getSettings().fullAccessBotIds?.includes(botId) === true
}

export function botSessionRequiresFullAccess(
  runtime: OrcaRuntimeService,
  sessionId: string
): boolean {
  if (!runtime.requireStore().getSettings().fullAccessBotIds?.length) {
    return false
  }
  const bot = botOfSession(runtime.bots, sessionId)
  if (bot && botRequiresFullAccess(runtime, bot.id)) {
    return true
  }
  const db = runtime.getOrchestrationDb()
  const worker = resolveStructuredWorkerIdentityForSession(sessionId, db)
  const dispatch = worker && db.getLatestDispatchForTerminal(worker.handle, worker.paneKey)
  return !!dispatch && botWorkerRequiresFullAccess(runtime, dispatch.id)
}

export function botWorkerRequiresFullAccess(
  runtime: OrcaRuntimeService,
  dispatchId: string
): boolean {
  if (!runtime.requireStore().getSettings().fullAccessBotIds?.length) {
    return false
  }
  return startedForBot(runtime.getOrchestrationDb(), dispatchId, (sessionId) => {
    const bot = botOfSession(runtime.bots, sessionId)
    return !!bot && botRequiresFullAccess(runtime, bot.id)
  })
}

type BotLaunchCaller = {
  agentSessionId?: string
  orcaSessionId?: string | null
  terminalHandle?: string | null
  paneKey?: string | null
}

export function botCallerRequiresFullAccess(
  runtime: OrcaRuntimeService,
  caller: BotLaunchCaller
): boolean {
  if (!runtime.requireStore().getSettings().fullAccessBotIds?.length) {
    return false
  }
  const sessionId = caller.agentSessionId ?? caller.orcaSessionId
  if (sessionId && botSessionRequiresFullAccess(runtime, sessionId)) {
    return true
  }
  const dispatch =
    caller.terminalHandle &&
    runtime
      .getOrchestrationDb()
      .getLatestDispatchForTerminal(caller.terminalHandle, caller.paneKey ?? undefined)
  return !!dispatch && botWorkerRequiresFullAccess(runtime, dispatch.id)
}

export function refuseUnpropagatedBotAccess(
  runtime: OrcaRuntimeService,
  caller: BotLaunchCaller | undefined,
  from?: string
): void {
  if (botCallerRequiresFullAccess(runtime, caller ?? { terminalHandle: from })) {
    throw new Error(
      'Full Access bot workers cannot start on a remote host until permission-policy propagation is supported.'
    )
  }
}
