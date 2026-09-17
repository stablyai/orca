import { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import {
  prepareStructuredConversationCommand,
  type ConversationCommandParams,
  type ConversationCommandResult,
  type PendingConversationCommand
} from './structured-conversation-command'
import { StructuredConversationCommandExecution } from './structured-conversation-command-execution'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export class StructuredConversationCommandController {
  private readonly pending = new Map<string, PendingConversationCommand>()
  private readonly execution: StructuredConversationCommandExecution

  constructor(
    private readonly context: () => StructuredAgentSessionMutationContext,
    host: Pick<
      StructuredAgentSessionHost,
      'attach' | 'close' | 'flushStreamedEvents' | 'hasSession'
    >
  ) {
    this.execution = new StructuredConversationCommandExecution(context, host, {
      isCurrent: (entry) => this.isCurrent(entry),
      finish: (entry, result) => this.finish(entry, result),
      settleWaiter: (entry, result) => this.settleWaiter(entry, result),
      report: (entry, error) => this.report(entry, error)
    })
  }

  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof sendStructuredAgentSessionTurn> =>
    sendStructuredAgentSessionTurn(this.context(), caller, params)

  run = (
    caller: StructuredAgentSessionCaller,
    params: ConversationCommandParams
  ): Promise<ConversationCommandResult> => {
    const sessionId = params.envelope.sessionId
    const key = JSON.stringify([
      caller.callerKey,
      params.envelope.clientOperationId,
      params.command,
      params.envelope.expectedRuntimeFence,
      params.envelope.payloadFingerprint
    ])
    const pending = this.pending.get(sessionId)
    if (pending) {
      return pending.key === key
        ? pending.promise
        : Promise.resolve({
            ok: false,
            refusal: {
              code: 'agent_session_operation_invalid',
              message: 'Wait for the conversation operation to finish.'
            }
          })
    }
    const waiter = Promise.withResolvers<ConversationCommandResult>()
    const entry: PendingConversationCommand = {
      key,
      command: params.command,
      operationId: params.envelope.clientOperationId,
      execution: null,
      promise: waiter.promise,
      resolve: waiter.resolve,
      waiterSettled: false
    }
    this.pending.set(sessionId, entry)
    void this.context()
      .serialize(sessionId, async () => {
        const prepared = await prepareStructuredConversationCommand(this.context(), caller, params)
        if (prepared.decision === 'return') {
          this.finish(entry, prepared.result)
          return false
        }
        entry.execution = prepared.execution
        return true
      })
      .then((execute) => {
        if (execute) {
          void this.execution.run(entry).catch((error) => this.report(entry, error))
        }
      })
      .catch((error) => this.failAdmission(entry, error))
    return entry.promise
  }

  /** Called while the session lane is held. It terminalizes the host token before teardown. */
  abandon = async (sessionId: string, turnId?: string): Promise<void> => {
    const entry = this.pending.get(sessionId)
    if (
      !entry?.execution ||
      (turnId !== undefined && turnId !== `${entry.command}:${entry.operationId}`)
    ) {
      return
    }
    this.finish(entry, await this.execution.abandon(entry))
  }

  abandonAll = async (): Promise<void> => {
    await Promise.all(
      [...this.pending.keys()].map((sessionId) =>
        this.context().serialize(sessionId, () => this.abandon(sessionId))
      )
    )
  }

  replacements = () => {
    const store = this.context().deps.store
    const records = store.listRecords()
    const visible = new Set(store.listVisibleSessionIds())
    const byId = new Map(records.map((record) => [record.sessionId, record]))
    const destinations = new Map<string, string | null>()
    const destination = (source: string): string | null => {
      const path = new Set<string>()
      let current = source
      while (!destinations.has(current) && !path.has(current)) {
        path.add(current)
        const command = byId.get(current)?.conversationCommand
        if (
          command?.command !== 'clear' ||
          command.phase !== 'committed' ||
          !command.replacementSessionId
        ) {
          destinations.set(current, current)
          break
        }
        current = command.replacementSessionId
      }
      const target = destinations.get(current) ?? null
      for (const id of path) {
        destinations.set(id, target)
      }
      return target
    }
    return records.flatMap((record) => {
      const target = destination(record.sessionId)
      const sessionId = target !== record.sessionId ? target : null
      return sessionId && visible.has(sessionId) && !visible.has(record.sessionId)
        ? [
            {
              sourceSessionId: record.sessionId,
              sessionId,
              workspaceId: record.location.workspaceId,
              agent: record.provider
            }
          ]
        : []
    })
  }

  private isCurrent(entry: PendingConversationCommand): boolean {
    const sessionId = entry.execution?.turn.sessionId
    return sessionId !== undefined && this.pending.get(sessionId) === entry
  }

  private settleWaiter(entry: PendingConversationCommand, result: ConversationCommandResult): void {
    if (!entry.waiterSettled) {
      entry.waiterSettled = true
      entry.resolve(result)
    }
  }

  private finish(entry: PendingConversationCommand, result: ConversationCommandResult): void {
    const sessionId = entry.execution?.turn.sessionId
    if (sessionId && this.pending.get(sessionId) === entry) {
      this.pending.delete(sessionId)
    } else {
      for (const [candidate, pending] of this.pending) {
        if (pending === entry) {
          this.pending.delete(candidate)
          break
        }
      }
    }
    this.settleWaiter(entry, result)
  }

  private failAdmission(entry: PendingConversationCommand, error: unknown): void {
    this.finish(entry, {
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: error instanceof Error ? error.message : 'Conversation operation failed.'
      }
    })
  }

  private report(entry: PendingConversationCommand, error: unknown): void {
    this.context().deps.onEventSinkError?.({
      sessionId: entry.execution?.turn.sessionId ?? 'unknown',
      error
    })
  }
}
