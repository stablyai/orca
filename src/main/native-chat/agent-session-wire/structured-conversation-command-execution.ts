import type {
  AgentSessionConversationCommandRecord,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import { attachConversationClearReplacement } from './structured-conversation-clear-replacement'
import {
  conversationCommandExecutionIsCurrent,
  conversationCommandResult,
  persistConversationCommandResult,
  type ConversationCommandResult,
  type PendingConversationCommand as PendingCommand,
  type PreparedConversationCommand as PreparedCommand
} from './structured-conversation-command'
import {
  COMPACTION_UNCONFIRMED,
  CONVERSATION_COMMAND_ABANDONED,
  publishConversationCommandLifecycle
} from './structured-conversation-command-lifecycle'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionHost as Host } from './structured-agent-session-host'

type ExecutionOwner = {
  isCurrent: (entry: PendingCommand) => boolean
  finish: (entry: PendingCommand, result: ConversationCommandResult) => void
  settleWaiter: (entry: PendingCommand, result: ConversationCommandResult) => void
  report: (entry: PendingCommand, error: unknown) => void
}
type ExecutionHost = Pick<Host, 'attach' | 'close' | 'flushStreamedEvents' | 'hasSession'>

export class StructuredConversationCommandExecution {
  constructor(
    private readonly context: () => StructuredAgentSessionMutationContext,
    private readonly host: ExecutionHost,
    private readonly owner: ExecutionOwner
  ) {}

  async run(entry: PendingCommand): Promise<void> {
    const execution = entry.execution
    if (!execution || !this.owner.isCurrent(entry)) {
      return
    }
    let providerMaySettleLate = false
    try {
      await this.publishLifecycle(entry, execution.prepared, 'running')
      if (await this.retireStale(entry, execution)) {
        return
      }
      await this.host.flushStreamedEvents(execution.turn.sessionId)
      if (await this.retireStale(entry, execution)) {
        return
      }
      providerMaySettleLate = entry.command === 'compact'
      await (entry.command === 'clear'
        ? this.executeClear(entry, execution)
        : this.executeCompact(entry, execution))
    } catch (error) {
      await this.markUnknown(entry, error, !providerMaySettleLate)
    }
  }

  async abandon(entry: PendingCommand): Promise<ConversationCommandResult> {
    const execution = entry.execution
    if (!execution) {
      throw new Error('Conversation command was not prepared.')
    }
    const value: AgentSessionConversationCommandRecord = {
      ...execution.prepared,
      phase: 'committed',
      state: 'unknown',
      error: CONVERSATION_COMMAND_ABANDONED,
      ...(entry.command === 'clear' ? { replacementSessionId: undefined } : {})
    }
    try {
      await persistConversationCommandResult(this.context(), execution, value)
      await this.publishLifecycle(entry, value, 'interrupted')
    } catch (error) {
      this.owner.report(entry, error)
    }
    return conversationCommandResult(execution, value)
  }

  private async executeCompact(entry: PendingCommand, execution: PreparedCommand): Promise<void> {
    const compact = execution.turn.adapter.compact
    if (!compact) {
      await this.complete(entry, 'Compaction is unavailable for this provider.')
      return
    }
    const result = await compact({
      turnId: `compact:${entry.operationId}`,
      sessionId: execution.turn.sessionId,
      fence: execution.turn.fence,
      onLateResult: (late) => this.complete(entry, late.error)
    })
    if (await this.retireStale(entry, execution)) {
      return
    }
    try {
      await this.host.flushStreamedEvents(execution.turn.sessionId)
    } catch (error) {
      await this.markUnknown(entry, error, true)
      return
    }
    await this.complete(entry, result.error)
  }

  private async executeClear(entry: PendingCommand, execution: PreparedCommand): Promise<void> {
    let effectiveOptions = execution.source.options
    if (!execution.supersededOperation) {
      try {
        const options = await execution.turn.adapter.readOptions?.({
          sessionId: execution.turn.sessionId,
          fence: execution.turn.fence
        })
        effectiveOptions = {
          ...effectiveOptions,
          ...(options
            ? {
                model: options.current.model,
                ...(options.current.effort ? { effort: options.current.effort } : {})
              }
            : {})
        }
      } catch {
        await this.complete(
          entry,
          'Could not read the current session configuration. Try again when the provider is connected.',
          true
        )
        return
      }
    }
    if (await this.retireStale(entry, execution)) {
      return
    }
    if (effectiveOptions) {
      await this.context().serialize(execution.turn.sessionId, async () => {
        if (this.canSettle(entry, execution)) {
          await execution.turn.persistOptions(effectiveOptions)
        }
      })
    }
    if (await this.retireStale(entry, execution)) {
      return
    }
    const replacementSessionId = execution.prepared.replacementSessionId!
    let attachError: string | null
    try {
      attachError = await attachConversationClearReplacement({
        host: this.host,
        store: this.context().deps.store,
        sourceSessionId: execution.turn.sessionId,
        replacementSessionId,
        callerKey: execution.supersededOperation?.callerKey ?? execution.prepared.callerKey,
        operationId: execution.supersededOperation?.operationId ?? execution.prepared.operationId,
        source: { ...execution.source, options: effectiveOptions }
      })
    } catch (error) {
      const replacement = this.context().deps.store.getRecord(replacementSessionId)
      // A reservation proves intent, not that this host can serve the replacement.
      if (
        replacement?.lease.claimStatus !== 'live' ||
        !this.host.hasSession(replacementSessionId)
      ) {
        throw error
      }
      attachError = null
    }
    if (!this.canSettle(entry, execution)) {
      if (!attachError) {
        await this.host
          .close(replacementSessionId)
          .catch((error) => this.owner.report(entry, error))
      }
      await this.markUnknown(entry, new Error(CONVERSATION_COMMAND_ABANDONED), true)
      return
    }
    await this.complete(entry, attachError ?? undefined, Boolean(attachError))
  }

  private async complete(
    entry: PendingCommand,
    error?: string,
    discardReplacement = false
  ): Promise<void> {
    const execution = entry.execution
    if (!execution) {
      return
    }
    await this.context().serialize(execution.turn.sessionId, async () => {
      if (!this.canSettle(entry, execution)) {
        await this.markUnknownInLane(entry, new Error(CONVERSATION_COMMAND_ABANDONED), true)
        return
      }
      const value: AgentSessionConversationCommandRecord = {
        ...execution.prepared,
        phase: 'committed',
        state: 'completed',
        ...(error ? { error: error.slice(0, 4096) } : {}),
        ...(discardReplacement ? { replacementSessionId: undefined } : {})
      }
      try {
        await persistConversationCommandResult(this.context(), execution, value)
      } catch (cause) {
        await this.markUnknownInLane(entry, cause, true)
        return
      }
      try {
        await this.publishLifecycle(entry, value, 'completed')
      } catch (cause) {
        this.owner.report(entry, cause)
      }
      this.owner.finish(entry, conversationCommandResult(execution, value))
    })
  }

  private async markUnknown(entry: PendingCommand, cause: unknown, retire = false): Promise<void> {
    const execution = entry.execution
    if (!execution) {
      return
    }
    await this.context().serialize(execution.turn.sessionId, () =>
      this.markUnknownInLane(entry, cause, retire)
    )
  }

  private async markUnknownInLane(
    entry: PendingCommand,
    cause: unknown,
    retire = false
  ): Promise<void> {
    const execution = entry.execution
    if (!execution) {
      return
    }
    const error = cause instanceof Error ? cause.message : COMPACTION_UNCONFIRMED
    const value: AgentSessionConversationCommandResult = {
      command: entry.command,
      state: 'unknown',
      error: entry.command === 'compact' ? COMPACTION_UNCONFIRMED : error.slice(0, 4096)
    }
    const result = conversationCommandResult(execution, value)
    if (!this.ownsExecution(entry, execution)) {
      if (this.owner.isCurrent(entry)) {
        this.owner.finish(entry, result)
      }
      return
    }
    try {
      await this.context().deps.store.recordOperationOutcome({
        callerKey: execution.operationCallerKey,
        operationId: execution.prepared.operationId,
        outcome: { status: 'unknown' }
      })
      await this.publishLifecycle(entry, value, retire ? 'unverifiable' : 'running')
    } catch (persistError) {
      this.owner.report(entry, persistError)
    }
    if (retire) {
      this.owner.finish(entry, result)
    } else {
      this.owner.settleWaiter(entry, result)
    }
  }

  private publishLifecycle(
    entry: PendingCommand,
    value: AgentSessionConversationCommandResult,
    state: Parameters<typeof publishConversationCommandLifecycle>[0]['state']
  ): Promise<void> {
    return publishConversationCommandLifecycle({
      context: this.context,
      command: entry.command,
      operationId: entry.operationId,
      execution: entry.execution!,
      value,
      state
    })
  }

  private canSettle(entry: PendingCommand, execution: PreparedCommand): boolean {
    const command = this.context().deps.store.getRecord(
      execution.turn.sessionId
    )?.conversationCommand
    return this.ownsExecution(entry, execution) && command?.phase === 'prepared'
  }

  private async retireStale(entry: PendingCommand, execution: PreparedCommand): Promise<boolean> {
    if (!this.canSettle(entry, execution)) {
      await this.markUnknown(entry, new Error(CONVERSATION_COMMAND_ABANDONED), true)
      return true
    }
    return false
  }

  private ownsExecution(entry: PendingCommand, execution: PreparedCommand): boolean {
    return (
      this.owner.isCurrent(entry) &&
      conversationCommandExecutionIsCurrent(this.context(), execution)
    )
  }
}
