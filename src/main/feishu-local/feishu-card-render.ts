import type { FeishuCardData } from './feishu-card-data'

export function feishuControlCard(data: FeishuCardData, botName: string, open: boolean) {
  const options = open ? data.options : []
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: (data.note ?? data.text).slice(0, 160) }
    },
    header: {
      title: { tag: 'plain_text', content: botName },
      subtitle: {
        tag: 'plain_text',
        content: data.kind === 'status' ? '工作状态' : data.note ? '已处理' : '等待你的选择'
      },
      template: data.note ? 'grey' : 'default',
      icon: { tag: 'standard_icon', token: 'ai-common_colorful' }
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: [
        // Plain text keeps tool commands and untrusted labels from introducing mentions or images.
        { tag: 'div', text: { tag: 'plain_text', content: data.text } },
        ...(data.note ? [{ tag: 'div', text: { tag: 'plain_text', content: data.note } }] : []),
        ...options.map((option, i) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: [...option.label].slice(0, 100).join('') },
          type: i === 0 ? 'primary_filled' : 'default',
          width: options.length === 1 ? 'fill' : 'default',
          behaviors: [{ type: 'callback', value: { orca: 'answer', option: option.id } }]
        }))
      ]
    }
  }
}
