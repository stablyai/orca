import { expect, it } from 'vitest'
import { openAiMessagesFromGenAi, openAiToolsFromGenAi } from './genai-openai-conversion.mjs'

it('keeps conversation roles and tool-response identity', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'Example request' }] },
    {
      role: 'model',
      parts: [
        { text: 'Example tool call' },
        { functionCall: { id: 'call-1', name: 'lookup', args: { id: 7 } } }
      ]
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'lookup',
            response: { found: true }
          }
        }
      ]
    }
  ]
  const messages = openAiMessagesFromGenAi({ systemInstruction: { parts: [] }, contents })
  expect(messages[0]).toEqual({ role: 'user', content: 'Example request' })
  expect(messages[1]).toEqual({
    role: 'assistant',
    content: 'Example tool call',
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":7}' }
      }
    ]
  })
  expect(messages[2]).toEqual({
    role: 'tool',
    tool_call_id: 'call-1',
    name: 'lookup',
    content: '{"found":true}'
  })
  const declarations = openAiToolsFromGenAi([{ functionDeclarations: [{ name: 'lookup' }] }])
  expect(declarations[0].function.name).toBe('lookup')
})
