import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { mainAgentState } from '../../../shared/main-agent-status'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'

export type TerminalAgentStopPreparation = {
  hasAgent: boolean
  paused: boolean
  current: () => boolean
  released: (predict?: boolean) => Promise<boolean>
  stop: () => Promise<'exited' | 'unproven'>
  commitRelease: () => void
  beforeInterrupt: () => Promise<void>
}

export async function stopTerminalAgentForChat(input: {
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
  try {
    await input.predict(prepared)
  } catch (error) {
    if (
      prepared.hasAgent &&
      isAgentSessionRefusalError(error) &&
      error.refusal.code === 'agent_session_conflict' &&
      error.refusal.details?.reason === 'conversationHeldElsewhere' &&
      !error.refusal.details.owner &&
      (await prepared.released(true))
    ) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'conversationHeldInOtherTerminal'
      })
    }
    throw error
  }
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
  prepared.commitRelease()
  return { ok: true }
}
