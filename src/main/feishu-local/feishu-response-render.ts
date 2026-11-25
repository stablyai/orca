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
  const texts = [...response.progress, ...(response.native?.messages ?? [])].map(
    (entry) => entry.text
  )
  return [...new Set(texts)].join('\n\n')
}
export function feishuResponseCard(data: FeishuCardData, botName: string, streaming = false) {
  const response = data.response!
  const complete = response.final !== undefined
  const native = response.native
  const text = feishuResponseText(data)
  const tools = native?.tools ?? []
  const elapsed = native
    ? Math.max(0, (native.completedAt ?? Date.now()) - native.startedAt)
    : undefined
  const history = [
    ...new Set([...response.progress, ...(native?.messages ?? [])].map((e) => e.text))
  ]
    .filter((entry) => entry !== response.final)
    .map(prose)
  const elements: CardElement[] = []
  if (tools.length) {
    const visible = complete ? tools : tools.slice(-3)
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
    panel.expanded = !complete
    elements.push(panel)
  } else if (response.trace.length) {
    const trace = (complete ? response.trace : response.trace.slice(-3)).map((content) => ({
      tag: 'div',
      text: { tag: 'plain_text', content }
    }))
    elements.push({ ...folded('执行记录', trace), expanded: !complete })
  }
  if (complete) {
    elements.unshift(prose(response.final || text || '已处理'))
    if (history.length) {
      elements.push(folded('过程记录', history))
    }
  } else {
    elements.push({
      ...prose(text || (tools.length ? '正在执行上述步骤…' : '等待 Agent 生成回复…')),
      element_id: 'answer'
    })
  }
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      ...(streaming
        ? {
            streaming_mode: !complete,
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
      title: { tag: 'plain_text', content: botName },
      subtitle: {
        tag: 'plain_text',
        content: complete
          ? `${data.text}${elapsed === undefined ? '' : ` · ${formatElapsed(elapsed)}`}`
          : tools.some((t) => t.status === 'running')
            ? '正在执行工具'
            : text
              ? '正在生成回复'
              : '正在准备回复'
      },
      template: response.phase === 'failed' ? 'red' : complete ? 'green' : 'blue',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' }
    },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '8px', elements }
  }
}
