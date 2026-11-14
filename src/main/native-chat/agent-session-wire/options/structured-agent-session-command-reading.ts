import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import { AT_REST_COMMANDS_READ_BUDGET_MS } from './at-rest-command-catalog'

export function readStructuredAgentSessionCommands(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  commandsOnRequest = false
) {
  const { adapter, store } = deps
  const live = adapter.readCommands?.(sessionId)
  if (live !== undefined) {
    return live
  }
  const record = store.getRecord(sessionId)
  return record
    ? commandsOnRequest
      ? adapter.atRestCommands?.snapshot?.(record).commands
      : adapter.atRestCommands?.read(record)
    : undefined
}

/** Wait briefly for scans because one-shot menu readers do not receive later updates. */
export async function readStructuredAgentSessionCommandsSettled(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  commandsOnRequest = false
) {
  const { adapter, store } = deps
  const live = adapter.readCommands?.(sessionId)
  const record = store.getRecord(sessionId)
  if (live !== undefined || !record) {
    return { commands: live, ...(commandsOnRequest ? { commandsPending: false } : {}) }
  }
  const commands = adapter.atRestCommands?.settled
    ? await adapter.atRestCommands.settled(
        record,
        AT_REST_COMMANDS_READ_BUDGET_MS,
        commandsOnRequest
      )
    : adapter.atRestCommands?.read(record)
  const current = adapter.readCommands?.(sessionId)
  const snapshot = commandsOnRequest ? adapter.atRestCommands?.snapshot?.(record) : undefined
  if (current === undefined && snapshot?.retryableFailure) {
    throw new Error('Command discovery unavailable')
  }
  return {
    commands: current ?? (snapshot ? snapshot.commands : commands),
    ...(commandsOnRequest
      ? {
          commandsPending: current === undefined && (snapshot?.commandsPending ?? false)
        }
      : {})
  }
}
