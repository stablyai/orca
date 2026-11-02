import { describe, expect, it } from 'vitest'
import { PiRpcMessages } from './rpc-messages'
import { PiRpcContextUsage } from './rpc-context-usage'
import { piRpcDialogPresentation } from './rpc-extension-dialogs'

describe('recorded Pi message and extension shapes', () => {
  it('keeps tool image results as native attachments while retaining text output', () => {
    const messages = new PiRpcMessages('images', new PiRpcContextUsage())
    const events = messages.tool({
      type: 'tool_execution_end',
      toolCallId: 'screenshot',
      toolName: 'read',
      result: {
        content: [
          { type: 'text', text: 'Screenshot' },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
        ]
      }
    })
    expect(events).toMatchObject([
      { body: { kind: 'tool-call', state: 'completed', output: { head: 'Screenshot' } } },
      {
        body: {
          kind: 'message',
          role: 'tool',
          blocks: [{ type: 'image-ref', url: 'data:image/png;base64,aW1hZ2U=' }]
        }
      }
    ])
    expect(JSON.stringify(events[0])).not.toContain('aW1hZ2U=')
  })
  it('keeps native select descriptions without changing the value returned to the extension', () => {
    const dialog = piRpcDialogPresentation({
      id: 'select-description',
      method: 'select',
      title: 'Choose an environment',
      options: ['staging', 'production'],
      optionDetails: [{ description: 'Safe test environment' }, {}]
    })
    expect(dialog?.body).toMatchObject({
      options: [
        { id: 'option-0', label: 'staging', description: 'Safe test environment' },
        { id: 'option-1', label: 'production' }
      ]
    })
    expect(
      dialog?.reply({ kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['option-0'] }] })
    ).toEqual({ value: 'staging' })
  })
})
