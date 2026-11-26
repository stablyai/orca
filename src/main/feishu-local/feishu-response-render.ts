import type { FeishuCardData } from './feishu-card-data'
import { buildStreamingToolUseActivePanel, formatElapsed } from './upstream/tool-panel'
import type { CardElement } from './upstream/tool-steps'

function prose(content: string): CardElement {
  return content.includes('![') || /<img\b/i.test(content)
    ? { tag: 'div', text: { tag: 'plain_text', content } }
    : { tag: 'markdown', content }
}
function folded(title: string, elements: CardElement[]): CardElement {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: title },
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180
    },
    elements
  }
}
export function feishuResponseText(data: FeishuCardData): string {
  const response = data.response!
  const baseline =
    response.baseline?.turnItemId === response.native?.turnItemId ? response.baseline : undefined
  const texts = [
    ...response.progress.map((entry) => entry.text),
    ...(response.native?.messages ?? []).flatMap((entry) => {
      if (response.final?.trim() === entry.text.trim()) {
        return []
      }
      const before = baseline?.messages.find((m) => m.id === entry.id)?.text
      const text =
        before && entry.text.startsWith(before) ? entry.text.slice(before.length) : entry.text
      return text.trim() ? [text] : []
    })
  ]
  if (response.final) {
    texts.push(response.final)
  }
  return [...new Set(texts)].join('\n\n')
}
export function feishuResponseCard(data: FeishuCardData, botName: string, streaming = false) {
  const response = data.response!
  const complete = response.final !== undefined
  const superseded = Boolean(response.supersededBy)
  const waiting = Boolean(response.question?.pending) && !superseded
  const stopped = complete || superseded || waiting
  const native = response.native
  const text = feishuResponseText(data)
  const tools = (native?.tools ?? []).filter(
    (tool) =>
      response.baseline?.turnItemId !== native?.turnItemId ||
      !response.baseline?.tools.some(
        (previous) => previous.id === tool.id && previous.status !== 'running'
      )
  )
  const elapsed = native
    ? Math.max(0, (response.stoppedAt ?? native.completedAt ?? Date.now()) - native.startedAt)
    : undefined
  const elements: CardElement[] = []
  if (tools.length) {
    const visible = stopped ? tools : tools.slice(-3)
    const panel = buildStreamingToolUseActivePanel({
      steps: visible.map((tool) => ({
        ...tool,
        title:
          tool.durationMs === undefined
            ? tool.title
            : `${tool.title} · ${formatElapsed(tool.durationMs)}`
      })),
      elapsedMs: elapsed,
      totalSteps: tools.length
    })
    panel.expanded = !stopped
    elements.push(panel)
  } else if (response.trace.length) {
    const trace = (stopped ? response.trace : response.trace.slice(-3)).map((content) => ({
      tag: 'div',
      text: { tag: 'plain_text', content }
    }))
    elements.push({ ...folded('执行记录', trace), expanded: !stopped })
  }
  if (stopped) {
    elements.push(
      prose(
        text ||
          (superseded ? '后续内容见最新提问下的回复' : waiting ? '请在选项卡片中回答' : '已处理')
      )
    )
  } else {
    elements.push({
      ...prose(text || (tools.length ? '正在执行上述步骤…' : '等待 Agent 生成回复…')),
      element_id: 'answer'
    })
  }
  const status = superseded
    ? '已转至最新提问'
    : waiting
      ? '等待你的选择'
      : complete
        ? `${data.text}${elapsed === undefined ? '' : ` · ${formatElapsed(elapsed)}`}`
        : tools.some((t) => t.status === 'running')
          ? '正在执行工具'
          : text
            ? '正在生成回复'
            : '正在准备回复'
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      ...(streaming
        ? {
            streaming_mode: !stopped,
            streaming_config: {
              print_frequency_ms: { default: 70 },
              print_step: { default: 1 },
              print_strategy: 'fast'
            }
          }
        : {}),
      summary: { content: (response.final || text || data.text).slice(0, 160) }
    },
    header: {
      title: { tag: 'plain_text', content: `${botName} · ${status}` },
      template: superseded
        ? 'grey'
        : waiting
          ? 'blue'
          : response.phase === 'failed'
            ? 'red'
            : complete
              ? 'green'
              : 'blue',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' }
    },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '8px', elements }
  }
}
