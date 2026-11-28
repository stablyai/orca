import { describe, expect, it } from 'vitest'
import { parseAskFromToolInput } from '../../../../../shared/native-chat/input/native-chat-ask'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'

describe('sanitizeNativeChatRpcBlock', () => {
  it('sends an oversize OMP form to mobile as questions it can still read', () => {
    const preamble = `<p>${'Background on the change. '.repeat(400)}</p>`
    const html = `<form>${preamble}<label>Reviewer <select name="r"><option>Ann<option selected>Bob</select></label></form>`
    const input = { html }
    const sent = sanitizeNativeChatRpcBlock({ type: 'tool-call', name: 'ask', input }, 'mobile')

    if (sent.type !== 'tool-call') {
      throw new Error('expected a tool-call block')
    }
    expect(JSON.stringify(sent.input).length).toBeLessThanOrEqual(4000)
    expect(parseAskFromToolInput('ask', sent.input)?.questions).toEqual([
      expect.objectContaining({
        question: 'Reviewer',
        multiSelect: false,
        options: [
          expect.objectContaining({ label: 'Ann' }),
          expect.objectContaining({ label: 'Bob' })
        ]
      })
    ])
  })

  it('keeps a small OMP form as html', () => {
    const input = { html: '<form><label>Name <input name="n"></label></form>' }
    expect(sanitizeNativeChatRpcBlock({ type: 'tool-call', name: 'ask', input }, 'mobile')).toEqual(
      {
        type: 'tool-call',
        name: 'ask',
        input
      }
    )
  })
})
