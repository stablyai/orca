import { describe, expect, it } from 'vitest'
import { codexImageGenerationEnabled } from './avatar-generation-capability'
import {
  agentErrorText,
  antigravityConversationIds,
  classifyAvatarAgentFailure,
  codexThreadId,
  grokImagePaths
} from './avatar-image-agent-output'

describe('codexThreadId', () => {
  it('reads the thread id that names the image folder', () => {
    const stdout = [
      'Reading additional input from stdin...',
      '{"type":"thread.started","thread_id":"01a1f10f-d7f4-7d91-b29d-5ee0b2b3264e"}',
      '{"type":"turn.started"}'
    ].join('\n')
    expect(codexThreadId(stdout)).toBe('01a1f10f-d7f4-7d91-b29d-5ee0b2b3264e')
  })

  it('refuses an id that could leave the image folder', () => {
    expect(codexThreadId('{"type":"thread.started","thread_id":"../../etc"}')).toBeNull()
  })
})

describe('grokImagePaths', () => {
  it('takes the saved path from the completed image tool call', () => {
    const id = 'call-4a26-0'
    const reply = JSON.stringify({
      path: '/Users/me/.grok/sessions/x/images/owl.jpg',
      filename: 'owl.jpg'
    })
    const stdout = [
      JSON.stringify({
        type: 'tool_call',
        toolCallId: id,
        toolName: 'image_gen',
        status: 'pending'
      }),
      JSON.stringify({ type: 'tool_call_update', toolCallId: id, status: null, content: [] }),
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: id,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: reply } }]
      })
    ].join('\n')
    expect(grokImagePaths(stdout)).toEqual(['/Users/me/.grok/sessions/x/images/owl.jpg'])
  })

  it('ignores paths from other tools', () => {
    const reply = JSON.stringify({ path: '/etc/passwd' })
    const stdout = [
      JSON.stringify({ type: 'tool_call', toolCallId: 'a', toolName: 'read_file' }),
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'a',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: reply } }]
      })
    ].join('\n')
    expect(grokImagePaths(stdout)).toEqual([])
  })
})

describe('antigravityConversationIds', () => {
  it('lists the run conversation first, then its subagents, and drops unsafe ids', () => {
    const stdout = [
      JSON.stringify({ event: 'init', conversation_id: 'main-1', init: { cwd: '/tmp/x' } }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'main-1',
          subagent_info: { subagents: [{ type_name: 'image-generator', conversation_id: 'sub-2' }] }
        }
      }),
      JSON.stringify({ event: 'step_update', step_update: { conversation_id: '../../etc' } })
    ].join('\n')
    expect(antigravityConversationIds(stdout)).toEqual(['main-1', 'sub-2'])
  })
})

describe('agentErrorText', () => {
  it('reads an agy result that did not succeed', () => {
    const stdout = JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'You have reached your quota limit.' }
    })
    expect(agentErrorText(stdout).trim()).toBe('You have reached your quota limit.')
  })

  it('reads error events and skips token counts that look like status codes', () => {
    const stdout = [
      '{"type":"turn.completed","usage":{"input_tokens":401,"output_tokens":429}}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}'
    ].join('\n')
    expect(agentErrorText(stdout).trim()).toBe("You've hit your usage limit.")
    expect(agentErrorText(stdout.split('\n')[0])).toBe('')
  })
})

describe('classifyAvatarAgentFailure', () => {
  it.each([
    [
      '{"type":"error","message":"You\'ve hit your usage limit. Try again at 3:00 PM."}',
      'usage-limit'
    ],
    ['ERROR: unexpected status 401 Unauthorized', 'signed-out'],
    ['Not logged in. Run codex login.', 'signed-out'],
    ['thread panicked', 'failed']
  ])('%s -> %s', (output, expected) => {
    expect(classifyAvatarAgentFailure(output)).toBe(expected)
  })
})

describe('codexImageGenerationEnabled', () => {
  it('reads the image_generation row of codex features list', () => {
    const on = 'guardian_x   under development  false\nimage_generation   stable   true\n'
    const off = 'image_generation   stable   false\nview_image   stable   true\n'
    expect(codexImageGenerationEnabled(on)).toBe(true)
    expect(codexImageGenerationEnabled(off)).toBe(false)
  })
})
