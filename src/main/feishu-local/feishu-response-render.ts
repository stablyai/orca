import type { FeishuCardData } from './feishu-card-data'

function prose(content: string) {
  return content.includes('![') || /<img\b/i.test(content)
    ? { tag: 'div', text: { tag: 'plain_text', content } }
    : { tag: 'markdown', content }
}

export function feishuResponseCard(data: FeishuCardData, botName: string) {
  const response = data.response!
  const complete = response.final !== undefined
  const progress = response.progress.map((entry) => prose(entry.text))
  const trace = (complete ? response.trace : response.trace.slice(-3)).map((content) => ({
    tag: 'div',
    text: { tag: 'plain_text', content }
  }))
  const history = [...progress, ...trace]
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: (response.final || data.text).slice(0, 160) }
    },
    header: {
      title: { tag: 'plain_text', content: botName },
      subtitle: { tag: 'plain_text', content: data.text },
      template: response.phase === 'failed' ? 'red' : complete ? 'green' : 'blue',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' }
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: complete
        ? [
            prose(response.final || response.progress.at(-1)?.text || '已处理'),
            ...(history.length
              ? [
                  {
                    tag: 'collapsible_panel',
                    expanded: false,
                    header: { title: { tag: 'plain_text', content: '进度与执行记录' } },
                    elements: history
                  }
                ]
              : [])
          ]
        : history.length
          ? history
          : [{ tag: 'div', text: { tag: 'plain_text', content: data.text } }]
    }
  }
}
