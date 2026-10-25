import { z } from 'zod'
import { BoundedMap } from '../../shared/bounded-map'
import type { AcpTimelineEvent as ProviderTimelineEvent } from './acp-timeline-event'
import { acpNotificationEnvelopeSchema, AcpContextTimeline } from './acp-context-usage'
import { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import {
  GENERIC_ACP_DIALECT,
  type AcpDialect,
  type AcpTurnEnding
} from './acp-dialects/acp-dialect'
import { AcpAgentError } from './acp-errors'
import { acpTurnEndEvents, AcpPromptTurns } from './acp-prompt-turns'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
import { translateAcpRequest } from './acp-timeline-requests'
import { ACP_SUBSTANTIVE_UPDATES, acpSessionUpdate } from './acp-session-update'
import { AcpSubagents } from './acp-subagents'
import { AcpToolTimeline } from './acp-tool-timeline'
import {
  AcpTurnFailures,
  acpAuthenticationRequired,
  acpPromptErrorDetail
} from './acp-turn-failures'
import { acpNamedTextKey, AcpTurnMessages, type AcpTextDrop } from './acp-turn-messages'
import type { PromptResponse } from './generated/acp-protocol.generated'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'

export { acpTurnEnd } from './acp-prompt-turns'

const requestSessionSchema = z.object({ sessionId: z.string() })

export type AcpTimelineTranslatorOptions = {
  sessionId: string
  dialect?: AcpDialect
  agentName?: string
  onTextDropped?: (drop: AcpTextDrop) => void
}

/** Consume frames once; callers retry returned events. State lasts only for this provider child. */
export class AcpTimelineTranslator {
  private readonly dialect: AcpDialect
  private readonly prompts: AcpPromptTurns
  private readonly tools = new AcpToolTimeline()
  private readonly backgroundTasks: AcpBackgroundTaskTimeline
  /** Drained by the lane in journal order. */
  readonly subagents = new AcpSubagents()
  private readonly messages = new AcpTurnMessages()
  private readonly started = new BoundedMap<string, true>({ maxEntries: 128 })
  private readonly failures: AcpTurnFailures
  private loading = false
  private readonly context = new AcpContextTimeline()
  private activeTurn?: string

  constructor(private readonly options: AcpTimelineTranslatorOptions) {
    this.dialect = options.dialect ?? GENERIC_ACP_DIALECT
    this.failures = new AcpTurnFailures(options.sessionId, this.dialect, options.agentName)
    this.backgroundTasks = new AcpBackgroundTaskTimeline((callId) => this.tools.turn(callId))
    this.prompts = new AcpPromptTurns(options.sessionId, this.dialect, options.agentName)
  }

  dispose(): void {
    this.subagents.dispose()
  }

  get injectsPromptIdentity(): boolean {
    return this.dialect.injectedPromptIdentity === true
  }

  /** Use the host's command turn for compaction; inject prompt identity only when supported. */
  openPrompt(
    clientMessageId: string,
    at: number,
    compactionTurn?: string
  ): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.loading) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    return this.prompts.open(clientMessageId, at, compactionTurn)
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
    const detail =
      error instanceof AcpAgentError ? acpPromptErrorDetail(this.dialect, error) : undefined
    const failure =
      error instanceof AcpAgentError ? this.dialect.promptFailure?.(error, at) : undefined
    const stopReason = failure?.stopReason ?? 'error'
    const ended = this.prompts.last
    const notSignedIn = this.authenticationRequired(error)
    if (this.prompts.current?.clientMessageId !== clientMessageId) {
      // A late prompt answer may supply a failure reason missing from the provider's end.
      return ended?.clientMessageId === clientMessageId && this.failures.has(ended.turn)
        ? this.failures.row(ended.turn, detail, stopReason, notSignedIn, failure?.usageLimit)
        : []
    }
    const ending = { ...failure, stopReason, at, failureDetail: detail, notSignedIn }
    return this.finishPrompt(clientMessageId, ending)
  }

  sessionLost(error: AcpAgentError): boolean {
    return this.dialect.sessionLost?.(error, this.options.sessionId) === true
  }

  authenticationRequired(error: unknown): boolean {
    return acpAuthenticationRequired(this.dialect, error)
  }

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

  contextModels(models: unknown, at: number): ProviderTimelineEvent[] {
    return this.context.models(models, at, this.dialect, { thread: this.options.sessionId })
  }

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

  get providerSessionId(): string {
    return this.options.sessionId
  }

  reconcileSubagent(
    id: string,
    state: NativeChatSubagentState,
    at: number
  ): ProviderTimelineEvent[] {
    return this.subagents.translate(
      [{ id, state, knownOnly: true }],
      { thread: this.options.sessionId },
      at
    )
  }

  /** Provisionally settle missing tasks; later provider endings may revise the outcome. */
  reconcileBackgroundTask(taskId: string): ProviderTimelineEvent[] {
    const update = { taskId, state: 'unverifiable' as const, summary: '', error: '' }
    return this.backgroundTasks.translate([update], { thread: this.options.sessionId })
  }

  sessionEvent(event: AcpSessionEvent, at: number): ProviderTimelineEvent[] {
    return this.notification(
      'session/update',
      event.kind === 'known' ? event.notification : event.raw,
      at
    )
  }

  notification(method: string, params: unknown, at: number): ProviderTimelineEvent[] {
    const session = requestSessionSchema.safeParse(params)
    if (session.success && session.data.sessionId !== this.options.sessionId) {
      const id = session.data.sessionId
      const child = acpNotificationEnvelopeSchema.safeParse(params)
      if (this.loading || !this.subagents.has(id) || !child.success || child.data._meta?.isReplay) {
        return []
      }
      const state = this.dialect.subagentSessionEnd?.(method, params)
      return state ? this.reconcileSubagent(id, state, at) : []
    }
    const extension = this.dialect.notification?.(method, params, at)
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
    const offeredTurn =
      providerTurn ?? (this.prompts.current?.opened ? this.prompts.current.turn : this.activeTurn)
    const owner = update ? this.messages.owner(offeredTurn, update) : { turn: offeredTurn }
    // Compaction frames join the host's open command turn without a provider turn key.
    const turn = this.prompts.compacting(owner.turn) ? undefined : owner.turn
    if (
      owner.settled &&
      (update?.sessionUpdate === 'agent_message_chunk' ||
        update?.sessionUpdate === 'agent_thought_chunk') &&
      update.messageId
    ) {
      const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
      this.options.onTextDropped?.({
        reason: 'turn-settled',
        itemId: acpNamedTextKey(update.messageId, channel),
        channel,
        threadId: this.options.sessionId,
        turnId: turn
      })
      return []
    }
    const events: ProviderTimelineEvent[] = []
    if (turn && opens) {
      events.push(...this.start(turn, extension?.at ?? at))
    }
    const join = { thread: this.options.sessionId, ...(turn === undefined ? {} : { turn }) }
    if (extension?.backgroundTasks) {
      const tasks = extension.backgroundTasks.filter((task) => !this.subagents.has(task.taskId))
      events.push(...this.backgroundTasks.translate(tasks, join))
    }
    if (extension?.subagents) {
      events.push(...this.subagents.translate(extension.subagents, join, at))
    }
    if (extension?.usage) {
      events.push(...this.context.update(extension.usage, join))
    }
    if (this.prompts.absorbCompaction(owner.turn, extension, update)) {
      return events
    }
    if (extension?.failureDetail && turn) {
      events.push(...this.failures.row(turn, extension.failureDetail))
    }
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
          ? this.messages.key(turn, standard.update)
          : undefined
      return [
        ...events,
        ...acpSessionUpdate(standard, turn, at, {
          tools: this.tools,
          dialect: this.dialect,
          backgroundTasks: this.backgroundTasks,
          subagents: this.subagents,
          messageKey
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
      tools: this.tools
    })
  }

  // Write failure reasons before ending the turn so their rows join it.
  private endTurn(turn: string, ending: AcpTurnEnding): ProviderTimelineEvent[] {
    const { stopReason, failureDetail, notSignedIn, usageLimit } = ending
    const events = this.prompts.endCompaction(turn, ending) ?? [
      ...this.failures.ended(turn, stopReason, failureDetail, notSignedIn, usageLimit),
      ...acpTurnEndEvents(this.options.sessionId, turn, ending)
    ]
    this.end(turn)
    if (this.prompts.current?.turn === turn) {
      this.prompts.finish()
    }
    return events
  }

  private start(turn: string, at: number): ProviderTimelineEvent[] {
    if (turn === this.prompts.current?.turn) {
      const events = this.prompts.start(turn, at)
      // Late frames must not reopen or retarget this prompt.
      this.started.set(turn, true)
      this.activeTurn = turn
      return events
    }
    if (this.started.has(turn)) {
      return []
    }
    this.started.set(turn, true)
    this.activeTurn = turn
    return [{ type: 'turn.open', turn, at }]
  }

  private end(turn: string): void {
    this.tools.end(turn)
    this.messages.end(turn)
    if (this.activeTurn === turn) {
      this.activeTurn = undefined
    }
  }
}
