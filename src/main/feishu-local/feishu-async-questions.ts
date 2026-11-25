import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  CODEX_ASYNC_QUESTION_TOOL,
  parseCodexAsyncQuestionsInput
} from '../../shared/native-chat/input/questions/codex-async-question-input'
import { formatAskAnswer } from '../../shared/native-chat/input/questions/native-chat-ask-answer'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuCardData } from './feishu-card-data'

/** Async questions answer as messages, matching the native chat composer, not approval responses. */
export class FeishuAsyncQuestions {
  private readonly lanes = new Map<string, string>()
  private pending = Promise.resolve()
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly store: FeishuStore,
    private readonly b: Binding,
    signal: AbortSignal,
    private readonly active: () => boolean,
    private readonly wake: () => void
  ) {
    let release: (() => void) | undefined
    const follow = () => {
      release?.()
      release = getStructuredAgentSessionHost()?.subscribeStatus({
        id: `feishu-questions:${b.account}`,
        emit: (event) => {
          if (event.type === 'snapshot') {
            event.sessions.forEach((summary) => this.update(summary))
          } else if (event.type === 'status') {
            this.update(event.session)
          }
        }
      })
    }
    const stop = onStructuredAgentSessionHostChanged(follow)
    follow()
    signal.addEventListener(
      'abort',
      () => {
        stop()
        release?.()
      },
      { once: true }
    )
  }
  track(external: string): void {
    const linked = this.runtime
      .getExternalConversationSeam()
      ?.linkedChat({ source: 'feishu-local', externalId: external }, this.b.bot)
    if (!linked || this.lanes.get(linked.sessionId) === external) {
      return
    }
    this.lanes.set(linked.sessionId, external)
    const summary = getStructuredAgentSessionHost()?.readStatusSummary(linked.sessionId)
    if (summary) {
      this.update(summary)
    }
  }
  private update(summary: AgentSessionStatusSummary): void {
    const external = this.lanes.get(summary.sessionId)
    if (!external || !this.active()) {
      return
    }
    this.pending = this.pending
      .then(() => this.record(summary, external))
      .catch(() => {
        this.wake()
      })
  }
  async flush(): Promise<void> {
    await this.pending
  }
  isCurrent(data: FeishuCardData, external: string): boolean {
    const linked = this.runtime
      .getExternalConversationSeam()
      ?.linkedChat({ source: 'feishu-local', externalId: external }, this.b.bot)
    const summary =
      data.sessionId && getStructuredAgentSessionHost()?.readStatusSummary(data.sessionId)
    return (
      !!summary &&
      linked?.sessionId === data.sessionId &&
      summary.awaitsAnswer === true &&
      summary.awaitsQuestion?.itemId === data.promptId
    )
  }
  private async record(summary: AgentSessionStatusSummary, external: string): Promise<void> {
    if (!this.active()) {
      return
    }
    const b = this.b
    const host = getStructuredAgentSessionHost()
    const current = host?.readStatusSummary(summary.sessionId)
    if (!host || current !== summary) {
      return
    }
    const question = summary.awaitsAnswer ? summary.awaitsQuestion : undefined
    await this.store.closePrompts(
      b.account,
      external,
      question?.itemId ?? null,
      '此问题已结束',
      'async-question'
    )
    if (!question) {
      this.wake()
      return
    }
    const route = await this.store.laneRoute(b.account, external)
    if (!route) {
      return
    }
    const reads = await host.journalReads(summary.sessionId)
    const item = await reads.item(question.itemId)
    if (!item || item.body.kind !== 'message' || item.body.role !== 'assistant') {
      return
    }
    const calls = item.body.blocks.filter(
      (block) => block.type === 'tool-call' && block.name === CODEX_ASYNC_QUESTION_TOOL
    )
    const call = calls.length === 1 ? calls[0] : null
    const prompt = call?.type === 'tool-call' ? parseCodexAsyncQuestionsInput(call.input) : null
    const q = prompt?.questions.length === 1 ? prompt.questions[0] : null
    const options =
      prompt && q && q.options.length <= 25
        ? q.options.map((option, index) => ({
            id: String(index),
            label: option.label,
            answer: formatAskAnswer(prompt, [{ indices: [index] }])
          }))
        : []
    if (
      !this.active() ||
      host.readStatusSummary(summary.sessionId)?.awaitsQuestion?.itemId !== question.itemId
    ) {
      return
    }
    await this.store.putCard(
      b.account,
      `async:${external}:${question.itemId}`,
      external,
      route.original,
      route.chat,
      {
        kind: 'async-question',
        promptId: question.itemId,
        sessionId: summary.sessionId,
        text: question.text + (options.length ? '' : '\n请在本话题中回复答案，或在 Orca 中回答。'),
        options
      }
    )
    this.wake()
  }
}
