import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionLatestTurn
} from '../../shared/agent-session/agent-session-wire'
import { describeToolInput } from '../../shared/native-chat/tools/native-chat-tool-summary'
import { connectorTurnActivityStepTitle } from '../../shared/connectors/connector-turn-activity-line'
import type { FeishuNativeResponse } from './feishu-native-data'
import { CODEX_ASYNC_QUESTION_TOOL } from '../../shared/native-chat/input/questions/codex-async-question-input'
import { isConversationReport } from '../external-conversations/external-conversation-turn-opener'

const TOOL_LABELS: [RegExp, string, string][] = [
  [/search/i, '搜索', 'search_outlined'],
  [/read|open|fetch|view/i, '读取', 'file-link-text_outlined'],
  [/write|edit|patch/i, '编辑', 'edit_outlined'],
  [/exec|command|bash|shell/i, '执行命令', 'code_outlined'],
  [/agent|task/i, '子任务', 'app-default_outlined']
]

export class FeishuNativeProjection {
  readonly items = new Map<string, AgentJournalRenderItem>()
  latest: AgentSessionLatestTurn | null = null
  apply(event: AgentSessionSubscribeEvent): void {
    if (event.type === 'end') {
      return
    }
    const frame = event.type === 'batch' ? event.batch : event.page
    if (event.type !== 'batch') {
      this.items.clear()
    }
    for (const id of frame.removedItemIds) {
      this.items.delete(id)
    }
    for (const item of frame.items) {
      const previous = this.items.get(item.itemId)
      if (!previous || item.revision >= previous.revision) {
        this.items.set(item.itemId, item)
      }
    }
    const latest = event.type === 'batch' ? event.latestTurn : event.page.latestTurn
    if (latest !== undefined) {
      this.latest = latest
    }
    for (const item of frame.items) {
      if (
        item.body.kind === 'turn' &&
        (!this.latest || item.observedAt >= this.latest.observedAt)
      ) {
        this.latest = { itemId: item.itemId, observedAt: item.observedAt, turn: item.body }
      }
    }
    while (this.items.size > 256) {
      this.items.delete(this.items.keys().next().value!)
    }
  }
  reportWorkers(): string[] | null {
    const id = this.latest?.turn.userItemId
    const body = id ? this.items.get(id)?.body : undefined
    if (!body || !isConversationReport(body) || body.kind !== 'message') {
      return null
    }
    const senders = body.from?.senders ?? []
    return senders.length > 0 && senders.every((sender) => sender.relation === 'worker')
      ? senders.map((sender) => sender.party.address)
      : null
  }
  project(
    account: string,
    external: string,
    reportOriginal?: string | null
  ): { original: string; continuations: string[]; native: FeishuNativeResponse } | null {
    const latest = this.latest
    const user = latest?.turn.userItemId && this.items.get(latest.turn.userItemId)
    const stamped =
      user &&
      user.body.kind === 'message' &&
      user.body.role === 'user' &&
      user.body.connectorDelivery
    const report = !stamped && reportOriginal && this.reportWorkers()
    const resumed =
      !stamped && user && user.body.kind === 'message'
        ? user.body.connectorClaim?.origin.filter(
            (stamp) =>
              stamp.account === account &&
              stamp.conversation.source === 'feishu-local' &&
              stamp.conversation.externalId === external
          )
        : undefined
    const delivery =
      stamped ||
      resumed?.[0] ||
      (report
        ? {
            account,
            conversation: { source: 'feishu-local', externalId: external },
            deliveryId: reportOriginal
          }
        : null)
    if (
      !latest ||
      !delivery ||
      delivery.account !== account ||
      delivery.conversation.source !== 'feishu-local' ||
      delivery.conversation.externalId !== external
    ) {
      return null
    }
    const native: FeishuNativeResponse = {
      turnItemId: latest.itemId,
      startedAt: latest.turn.startedAt ?? latest.observedAt,
      completedAt: latest.turn.completedAt,
      messages: [],
      tools: []
    }
    if (report) {
      native.report = true
    }
    if (resumed?.length) {
      native.resumed = true
    }
    if (latest.turn.outcome === 'cancellation') {
      native.cancelled = true
    } else if (latest.turn.outcome && latest.turn.outcome !== 'success') {
      native.failed = true
    }
    const continuations: string[] = (resumed?.slice(1) ?? []).map((stamp) => stamp.deliveryId)
    const ordered = [...this.items.values()].sort(
      (a, b) => a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
    )
    for (const item of ordered) {
      if (
        item.body.kind === 'agent-start' &&
        item.observedAt >= native.startedAt &&
        (native.completedAt === undefined || item.observedAt <= native.completedAt)
      ) {
        native.workers ??= []
        native.workers.push(item.body.worker.party.address)
      }
      if (item.turnScope?.kind !== 'turn' || item.turnScope.turnItemId !== latest.itemId) {
        continue
      }
      const body = item.body
      if (body.kind === 'message' && body.role === 'user') {
        const stamp = body.connectorDelivery
        if (
          stamp?.account === account &&
          stamp.conversation.source === 'feishu-local' &&
          stamp.conversation.externalId === external &&
          stamp.deliveryId !== delivery.deliveryId
        ) {
          continuations.push(stamp.deliveryId)
        }
      } else if (body.kind === 'message' && body.role === 'assistant') {
        if (
          body.blocks.some((b) => b.type === 'tool-call' && b.name === CODEX_ASYNC_QUESTION_TOOL)
        ) {
          // Replace any previously projected summary; the interactive question owns this text.
          native.messages.push({ id: item.itemId, text: '' })
          continue
        }
        const text = body.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
        if (text.trim() && !'NO_REPLY'.startsWith(text.trim()) && text.trim() !== 'NO_REPLY') {
          native.messages.push({ id: item.itemId, text })
        }
      } else if (body.kind === 'tool-call') {
        const label = TOOL_LABELS.find(([pattern]) => pattern.test(body.name))
        const id = body.callId ?? item.itemId
        const step = {
          id,
          title: label?.[1] ?? connectorTurnActivityStepTitle(body.name),
          iconToken: label?.[2] ?? 'app-default_outlined',
          detail: connectorTurnActivityStepTitle(describeToolInput(body.input)),
          status:
            body.state === 'running'
              ? ('running' as const)
              : body.state === 'failed' || (body.exitCode !== undefined && body.exitCode !== 0)
                ? ('error' as const)
                : ('success' as const),
          durationMs: body.durationMs
        }
        const previous = native.tools.findIndex((tool) => tool.id === id)
        if (previous !== -1) {
          native.tools[previous] = step
        } else {
          native.tools.push(step)
        }
      }
    }
    native.tools = native.tools.slice(-60)
    native.messages = native.messages.slice(-20)
    native.deliveries = [delivery.deliveryId, ...continuations]
    return { original: delivery.deliveryId, continuations, native }
  }
}
