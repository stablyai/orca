import type { AcpOwnershipReader } from '../journal/acp-ownership-reader'
import { BoundedMap } from '../../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  acpNotificationEnvelopeSchema,
  readAcpSessionEvent,
  type AcpSessionEvent
} from '../protocol/acp-session-events'
import { AcpContextTimeline } from './acp-context-usage'
import { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import {
  GENERIC_ACP_DIALECT,
  type AcpDialect,
  type AcpTurnEnding
} from '../acp-dialects/acp-dialect'
import type { AcpAgentError } from '../transport/acp-errors'
import { acpTurnEndEvents, AcpPromptTurns } from './acp-prompt-turns'

import { translateAcpRequest } from '../requests/acp-timeline-requests'
import { ACP_SUBSTANTIVE_UPDATES, acpSessionUpdate } from './acp-session-update'
import { AcpSubagents } from './acp-subagents'
import { AcpChildSessions } from './acp-child-sessions'
import { AcpTimelineOwnership } from './acp-timeline-ownership'
import { AcpTurnFailures } from './acp-turn-failures'
import { acpAuthenticationRequired, acpPromptErrorDetail } from '../turns/acp-prompt-failure'
import type { AcpTextDrop } from './acp-turn-messages'
import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { NativeChatSubagentState } from '../../../shared/native-chat/native-chat-types'

export type AcpTimelineTranslatorOptions = {
  sessionId: string
  dialect?: AcpDialect
  agentName?: string
  ownership?: AcpOwnershipReader
  onTextDropped?: (drop: AcpTextDrop) => void
}

/** Consume frames once; callers retry returned events. State lasts only for this provider child. */
export class AcpTimelineTranslator {
  readonly providerSessionId: string
  readonly injectsPromptIdentity: boolean
  private readonly dialect: AcpDialect
  private readonly prompts: AcpPromptTurns
  private readonly backgroundTasks: AcpBackgroundTaskTimeline
  /** Drained by the lane in journal order. */
  readonly subagents = new AcpSubagents()
  readonly children: AcpChildSessions
  private readonly ownership: AcpTimelineOwnership
  private readonly started = new BoundedMap<string, true>({ maxEntries: 128 })
  private readonly failures: AcpTurnFailures
  private loading = false
  private readonly context = new AcpContextTimeline()
  protected activeTurn?: string

  constructor(private readonly options: AcpTimelineTranslatorOptions) {
    this.ownership = new AcpTimelineOwnership(options.ownership)
    this.dialect = options.dialect ?? GENERIC_ACP_DIALECT
    this.providerSessionId = options.sessionId
    this.injectsPromptIdentity = this.dialect.injectedPromptIdentity === true
    this.failures = new AcpTurnFailures(options.sessionId, this.dialect, options.agentName)
    this.backgroundTasks = new AcpBackgroundTaskTimeline((callId) =>
      this.ownership.tools.join(callId)
    )
    this.prompts = new AcpPromptTurns(options.sessionId, this.dialect, options.agentName)
    const tools = this.ownership.tools
    this.children = new AcpChildSessions(options.sessionId, this.dialect, this.subagents, tools)
  }

  dispose(): void {
    this.ownership.dispose()
    this.subagents.dispose()
  }

  publication = (): (() => void) | undefined => this.ownership.publication()

  /** Use the host's command turn for compaction; inject prompt identity only when supported. */
  openPrompt(
    clientMessageId: string,
    at: number,
    compactionTurn?: string
  ): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.loading) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    const prompt = this.prompts.open(clientMessageId, at, compactionTurn)
    if (this.prompts.current?.opened) {
      this.ownership.operation().open(prompt.promptId)
    }
    return prompt
  }

  promptResult(
    clientMessageId: string,
    result: PromptResponse,
    at: number
  ): ProviderTimelineEvent[] {
    const hookBlock = this.dialect.hookBlock?.(result._meta)
    return this.finishPrompt(clientMessageId, { stopReason: result.stopReason, at, hookBlock })
  }

  /** Only agent-authored failures supply diagnostic text; connection loss is handled separately. */
  promptFailed(clientMessageId: string, error: Error, at: number): ProviderTimelineEvent[] {
    const result = this.prompts.failure(clientMessageId, error, at, this.failures)
    return Array.isArray(result) ? result : this.finishPrompt(clientMessageId, result)
  }

  sessionLost = (error: AcpAgentError): boolean =>
    this.dialect.sessionLost?.(error, this.options.sessionId) === true

  authenticationRequired = (error: unknown): boolean =>
    acpAuthenticationRequired(this.dialect, error)

  /** Return the agent's refusal before turn open; afterward the error belongs to `promptFailed`. */
  promptRefused(clientMessageId: string, error: AcpAgentError): string | null {
    return this.prompts.refuse(clientMessageId) ? acpPromptErrorDetail(this.dialect, error) : null
  }

  private finishPrompt(clientMessageId: string, ending: AcpTurnEnding): ProviderTimelineEvent[] {
    const prompt = this.prompts.current
    if (prompt?.clientMessageId !== clientMessageId) {
      return []
    }
    const events = this.start(prompt.turn, ending.at)
    events.push(...this.endTurn(prompt.turn, { ...ending, durationMs: prompt.durationMs }))
    return events
  }

  contextModels = (models: unknown, at: number): ProviderTimelineEvent[] =>
    this.context.models(models, at, this.dialect, { thread: this.options.sessionId })

  /** Discard loaded history except context-window information. */
  beginLoad(): void {
    if (this.prompts.current || this.loading) {
      throw new Error('ACP load overlaps a prompt or load')
    }
    this.loading = true
  }

  finishLoad(): void {
    this.loading = false
  }

  reconcileSubagent(
    id: string,
    state: NativeChatSubagentState,
    at: number
  ): ProviderTimelineEvent[] {
    return this.subagents.reconcile(id, state, this.options.sessionId, at)
  }

  /** Provisionally settle missing tasks; later provider endings may revise the outcome. */
  reconcileBackgroundTask(taskId: string): ProviderTimelineEvent[] {
    return this.backgroundTasks.reconcile(taskId, this.options.sessionId)
  }

  sessionEvent(event: AcpSessionEvent, at: number): ProviderTimelineEvent[] {
    return this.notification(
      'session/update',
      event.kind === 'known' ? event.notification : event.raw,
      at
    )
  }

  notification(method: string, params: unknown, at: number): ProviderTimelineEvent[] {
    if (this.ownership.disposed) {
      return []
    }
    const extension = this.dialect.notification?.(method, params, at)
    const open = this.prompts.current?.opened ? this.prompts.current.turn : this.activeTurn
    const child = this.children.notification(method, params, extension, this.loading, open, at)
    if (child) {
      return child
    }
    if (extension?.disposition === 'ignore') {
      return []
    }
    if (method !== 'session/update' && !extension) {
      return []
    }
    const envelope = acpNotificationEnvelopeSchema.safeParse(params)
    const read = method === 'session/update' ? readAcpSessionEvent(params) : null
    const standard = read?.kind === 'known' ? read.notification : undefined
    const update = standard?.update
    const markedReplay =
      (envelope.success && envelope.data._meta?.isReplay === true) || extension?.replay === true
    if (markedReplay || (extension?.replay === undefined && this.loading)) {
      return this.context.history(update, extension?.usage, at, { thread: this.options.sessionId })
    }
    const providerTurn = extension?.turn
    const opens =
      (update !== undefined && ACP_SUBSTANTIVE_UPDATES.includes(update.sessionUpdate)) ||
      extension?.end !== undefined ||
      extension?.started === true
    const offeredTurn = providerTurn ?? open
    const operation = this.ownership.operation()
    const owner = update
      ? this.ownership.messages.owner(offeredTurn, update, operation.settled)
      : { turn: offeredTurn }
    // Host command IDs cannot join provider-keyed turns, even when their late frames outlive `last`.
    const settledCommand =
      owner.turn?.startsWith('compact:') === true && this.prompts.current?.turn !== owner.turn
    const turn = this.prompts.compacting(owner.turn) || settledCommand ? undefined : owner.turn
    const drop = this.ownership.messages.rejection(update, owner, this.options.sessionId, turn)
    if (drop) {
      this.ownership.messages.observe(owner.turn, update)
      this.options.onTextDropped?.(drop)
      return []
    }
    const events: ProviderTimelineEvent[] = []
    if (turn && opens) {
      events.push(...this.start(turn, extension?.at ?? at, operation))
    }
    this.ownership.messages.observe(owner.turn, update)
    const join = {
      thread: this.options.sessionId,
      ...(turn === undefined ? {} : { turn }),
      ...(owner.scope ? { scope: owner.scope } : {})
    }
    if (extension?.backgroundTasks) {
      const tasks = extension.backgroundTasks.filter((task) => !this.subagents.has(task.taskId))
      events.push(...this.backgroundTasks.translate(tasks, join))
    }
    if (extension?.subagents) {
      events.push(...this.subagents.translate(extension.subagents, join, at))
    }
    if (extension?.subagentRoster) {
      events.push(
        ...this.subagents.translateRoster(
          extension.subagentRoster.seq,
          extension.subagentRoster.children,
          join,
          at
        )
      )
    }
    if (extension?.usage) {
      events.push(...this.context.update(extension.usage, join))
    }
    if (settledCommand || this.prompts.absorbCompaction(owner.turn, extension, update)) {
      return events
    }
    events.push(...this.failures.notification(turn, extension))
    const end = extension?.end
    if (end && turn) {
      // Hook refusal ends immediately; normal completion waits for the prompt reply.
      if (
        this.prompts.current?.turn === turn &&
        ['end_turn', 'cancelled'].includes(end.stopReason) &&
        !end.hookBlock
      ) {
        this.prompts.current.durationMs = end.durationMs
      } else {
        events.push(...this.endTurn(turn, { ...end, at }))
      }
      return events
    }
    if (standard) {
      const messageKey =
        turn && this.dialect.injectedPromptIdentity
          ? this.ownership.messages.key(turn, standard.update)
          : undefined
      return [
        ...events,
        ...acpSessionUpdate(standard, turn, at, {
          tools: this.ownership.tools,
          dialect: this.dialect,
          backgroundTasks: this.backgroundTasks,
          subagents: this.subagents,
          messageKey,
          scope: owner.scope
        })
      ]
    }
    if (method === 'session/update') {
      events.push({ type: 'provider.frame', frameKind: method, payload: params, join })
    }
    return events
  }

  request(
    method: string,
    params: unknown,
    id: string | number
  ): ReturnType<typeof translateAcpRequest> {
    return translateAcpRequest(method, params, id, {
      sessionId: this.options.sessionId,
      dialect: this.dialect,
      tools: this.ownership.tools
    })
  }

  // Write failure reasons before ending the turn so their rows join it.
  private endTurn(turn: string, ending: AcpTurnEnding): ProviderTimelineEvent[] {
    const events = this.prompts.endCompaction(turn, ending, this.failures) ?? [
      ...this.failures.ended(turn, ending),
      ...acpTurnEndEvents(this.options.sessionId, turn, ending)
    ]
    this.end(turn)
    if (this.prompts.current?.turn === turn) {
      this.prompts.finish()
    }
    return events
  }

  protected start(
    turn: string,
    at: number,
    operation = this.ownership.operation()
  ): ProviderTimelineEvent[] {
    if (
      operation.settled(turn) ||
      (this.prompts.current?.turn !== turn && this.started.has(turn))
    ) {
      return []
    }
    if (this.activeTurn && this.activeTurn !== turn) {
      this.end(this.activeTurn)
    }
    operation.open(turn)
    if (turn === this.prompts.current?.turn) {
      const events = this.prompts.start(turn, at)
      // Late frames must not reopen or retarget this prompt.
      this.started.set(turn, true)
      this.activeTurn = turn
      return events
    }
    this.started.set(turn, true)
    this.activeTurn = turn
    return [{ type: 'turn.open', turn, at }]
  }

  private end(turn: string): void {
    this.ownership.end(turn)
    if (this.activeTurn === turn) {
      this.activeTurn = undefined
    }
  }
}
