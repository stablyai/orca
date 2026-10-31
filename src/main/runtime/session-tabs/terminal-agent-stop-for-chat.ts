import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { mainAgentState } from '../../../shared/main-agent-status'
import { isAgentStatusHeldOpenByChildWork } from '../../../shared/agent-lead-status-fold'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'

const BACKGROUND_TASKS_NEED_CONSENT = false
export function needsStopConsent(
  row: AgentStatusIpcPayload | null
): 'turnActive' | 'backgroundTasksRunning' | null {
  if (!row) {
    return null
  }
  return mainAgentState(row) === 'working'
    ? 'turnActive'
    : BACKGROUND_TASKS_NEED_CONSENT && isAgentStatusHeldOpenByChildWork(row)
      ? 'backgroundTasksRunning'
      : null
}

export type TerminalAgentStopPreparation = {
  hasAgent: boolean
  paused: boolean
  current: () => boolean
  released: (predict?: boolean) => Promise<boolean>
  stop: () => Promise<'exited' | 'unproven'>
  beforeInterrupt: () => Promise<void>
}

export async function stopTerminalAgentForChat(input: {
  consented: boolean
  prepare: () => Promise<TerminalAgentStopPreparation>
  readRow: () => AgentStatusIpcPayload | null
  predict: (prepared: TerminalAgentStopPreparation) => Promise<unknown>
  interrupt: (beforeWrite: () => Promise<void>) => Promise<{ outcome: string }>
  subscribe: (changed: () => void) => () => void
}): Promise<{ ok: true }> {
  const unproven = () =>
    agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  const prepared = await input.prepare()
  if (!prepared.current()) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'conversationMoved'
    })
  }
  if (prepared.paused) {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'agentPaused' })
  }
  await input.predict(prepared)
  if (!prepared.current()) {
    throw unproven()
  }
  if (!prepared.hasAgent) {
    return { ok: true }
  }
  const fence = () => {
    if (!prepared.current()) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'conversationMoved'
      })
    }
    const reason = needsStopConsent(input.readRow())
    if (reason && !input.consented) {
      throw agentSessionRefusalError('agent_session_operation_invalid', { reason })
    }
  }
  fence()
  if (mainAgentState(input.readRow() ?? { state: 'done' }) === 'working') {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let check = () => {}
    const boundary = new Promise<void>((resolve) => {
      check = () => {
        if (
          !prepared.current() ||
          mainAgentState(input.readRow() ?? { state: 'done' }) !== 'working'
        ) {
          resolve()
        }
      }
      unsubscribe = input.subscribe(check)
      timer = setTimeout(resolve, 3_000)
      check()
    })
    try {
      const result = await input.interrupt(async () => {
        fence()
        await prepared.beforeInterrupt()
        fence()
      })
      if (result.outcome === 'accepted') {
        await boundary
      }
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  }
  fence()
  if ((await prepared.stop()) !== 'exited' || !prepared.current() || !(await prepared.released())) {
    throw unproven()
  }
  return { ok: true }
}
