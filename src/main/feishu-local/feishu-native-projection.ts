import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionLatestTurn
} from '../../shared/agent-session/agent-session-wire'
import { describeToolInput } from '../../shared/native-chat/tools/native-chat-tool-summary'
import { connectorTurnActivityStepTitle } from '../../shared/connectors/connector-turn-activity-line'
import type { FeishuNativeResponse } from './feishu-native-data'

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
  project(
    account: string,
    external: string
  ): { original: string; native: FeishuNativeResponse } | null {
    const latest = this.latest
    const user = latest?.turn.userItemId && this.items.get(latest.turn.userItemId)
    const delivery =
      user &&
      user.body.kind === 'message' &&
      user.body.role === 'user' &&
      user.body.connectorDelivery
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
    const ordered = [...this.items.values()].sort(
      (a, b) => a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
    )
    for (const item of ordered) {
      if (item.turnScope?.kind !== 'turn' || item.turnScope.turnItemId !== latest.itemId) {
        continue
      }
      const body = item.body
      if (body.kind === 'message' && body.role === 'assistant') {
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
    return { original: delivery.deliveryId, native }
  }
}
