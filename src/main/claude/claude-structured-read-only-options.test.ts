import { describe, expect, it } from 'vitest'
import { LOOK_AROUND_REFUSAL } from '../bots/bot-look-around-policy'
import {
  claudeReadOnlyOptions,
  claudeReadOnlyPreToolUse
} from './claude-structured-read-only-options'

function decide(toolName: string, toolInput: unknown) {
  return claudeReadOnlyPreToolUse(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 't1',
      session_id: 's1',
      transcript_path: '/tmp/t',
      cwd: '/tmp'
    },
    't1',
    { signal: new AbortController().signal }
  )
}

describe('a read-only Claude session', () => {
  it('allows reads explicitly, so nothing waits on a prompt nobody sees', async () => {
    expect(await decide('Bash', { command: 'gh pr view 12' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
    })
  })

  it.each([
    ['Bash', { command: 'orca connector post slack:T1:C1 --text hi' }],
    ['mcp__linear__create_issue', { title: 'x' }],
    ['Write', { file_path: 'MEMORY.md', content: 'x' }]
  ])('denies %s whatever the user allowed', async (tool, input) => {
    expect(await decide(tool, input)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: LOOK_AROUND_REFUSAL
      }
    })
  })

  it('also keeps writing tools out of the session', () => {
    expect(claudeReadOnlyOptions().disallowedTools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'WebFetch'])
    )
  })
})
