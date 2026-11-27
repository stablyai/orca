import { describe, expect, it } from 'vitest'
import { SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import { claudeBotSessionOptions } from './claude-bot-session-options'

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'

async function answer(command: string): Promise<unknown> {
  const options = await claudeBotSessionOptions(
    { instructions: async () => null, readOnly: null },
    [],
    SessionMcpTools.none,
    { mcpConfig: false }
  )
  const [matcher] = options.hooks?.PreToolUse ?? []
  expect(matcher?.matcher).toBe('Bash')
  const output = await matcher.hooks[0](
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 't',
      session_id: 's',
      transcript_path: '',
      cwd: '/'
    },
    't',
    { signal: new AbortController().signal }
  )
  const specific = 'hookSpecificOutput' in output ? output.hookSpecificOutput : undefined
  return specific?.hookEventName === 'PreToolUse' ? specific.permissionDecision : undefined
}

describe('a chat answers its own Orca reads', () => {
  it.each([
    [`${CLI} bot connectors`, 'allow'],
    [`${CLI} bot item list; ${CLI} bot list && ${CLI} repo list 2>&1`, 'allow'],
    // Writes, other programs, and commands Claude can check itself keep Claude's own answer.
    [`${CLI} bot reply --text 'hi'`, undefined],
    [`${CLI} orchestration reply --id 1 --body 'ok'`, undefined],
    [`${CLI} bot list; rm -rf x`, undefined],
    [`${CLI} bot list; gh pr view 1`, undefined],
    [`${CLI} bot list | sh`, undefined],
    ['orca bot list', undefined],
    [`echo "exit=\${pipestatus[1]}"`, undefined]
  ])('%s', async (command, decision) => {
    expect(await answer(command)).toBe(decision)
  })
})
