import { describe, expect, it } from 'vitest'
import { decodeCodexTranscriptLine } from './transcript-line-decoders'

function decode(payload: Record<string, unknown>) {
  return decodeCodexTranscriptLine(
    JSON.stringify({ type: 'response_item', payload }),
    'fallback-id'
  )
}

describe('decodeCodexTranscriptLine', () => {
  it('parses function arguments once and preserves nested JSON strings', () => {
    const argumentsJson = JSON.stringify({
      command: ['bash', '-lc', 'make'],
      metadata: '{"retries":1}'
    })

    expect(
      decode({
        type: 'function_call',
        call_id: 'call-function',
        name: 'shell',
        arguments: argumentsJson
      })
    ).toMatchObject({
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'shell',
          input: {
            command: ['bash', '-lc', 'make'],
            metadata: '{"retries":1}'
          },
          callId: 'call-function'
        }
      ]
    })
  })

  it('keeps malformed function arguments as raw input', () => {
    expect(
      decode({
        type: 'function_call',
        call_id: 'call-malformed',
        name: 'shell',
        arguments: '{not valid json'
      })
    ).toMatchObject({
      blocks: [
        {
          type: 'tool-call',
          input: '{not valid json',
          callId: 'call-malformed'
        }
      ]
    })
  })

  it('preserves native apply_patch custom input as freeform text', () => {
    const input = '*** Begin Patch\n*** Add File: src/new.ts\n+export {}\n*** End Patch'

    expect(
      decode({
        type: 'custom_tool_call',
        call_id: 'call-patch',
        name: 'apply_patch',
        status: 'in_progress',
        input
      })
    ).toMatchObject({
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'apply_patch',
          input,
          callId: 'call-patch',
          status: 'in-progress'
        }
      ]
    })
  })

  it.each([
    'Success.\nUpdated the following files:\nA src/new.ts\n',
    'Success. Updated the following files:\nA src/new.ts\n'
  ])('recognizes a native apply_patch success envelope', (output) => {
    expect(
      decode({
        type: 'custom_tool_call_output',
        call_id: 'call-patch',
        output
      })
    ).toMatchObject({
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          callId: 'call-patch',
          outcome: 'success'
        }
      ]
    })
  })

  it('recognizes the native apply_patch verification failure envelope', () => {
    expect(
      decode({
        type: 'custom_tool_call_output',
        call_id: 'call-patch',
        output: 'apply_patch verification failed: Invalid Context 0:\nold line'
      })
    ).toMatchObject({
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          callId: 'call-patch',
          isError: true,
          outcome: 'error'
        }
      ]
    })
  })

  it.each(['function_call_output', 'custom_tool_call_output'])(
    'keeps arbitrary %s strings unknown even when they sound like failures',
    (type) => {
      expect(
        decode({
          type,
          call_id: 'call-unknown',
          output: 'Error: process returned exit code 1'
        })
      ).toMatchObject({
        blocks: [
          {
            type: 'tool-result',
            callId: 'call-unknown',
            output: 'Error: process returned exit code 1',
            outcome: 'unknown'
          }
        ]
      })
    }
  )

  it('does not infer success from a legacy negative error flag', () => {
    expect(
      decode({
        type: 'function_call_output',
        call_id: 'call-unknown',
        output: { content: 'process finished', is_error: false }
      })
    ).toMatchObject({
      blocks: [{ type: 'tool-result', outcome: 'unknown' }]
    })
  })

  it.each([
    ['in_progress', 'in-progress'],
    ['completed', 'completed'],
    ['incomplete', 'incomplete']
  ] as const)('maps local_shell_call status %s to %s', (providerStatus, status) => {
    const action = { type: 'exec', command: ['git', 'status', '--short'] }

    expect(
      decode({
        type: 'local_shell_call',
        call_id: 'call-shell',
        status: providerStatus,
        action
      })
    ).toMatchObject({
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'shell',
          input: action,
          callId: 'call-shell',
          status
        }
      ]
    })
  })

  it.each(['tool_search_call', 'tool_search_output'])(
    'omits provider-side %s discovery records',
    (type) => {
      expect(decode({ type, call_id: 'search-1' })).toBeNull()
    }
  )
})
