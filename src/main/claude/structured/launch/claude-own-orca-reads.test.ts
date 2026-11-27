import { describe, expect, it } from 'vitest'
import { claudeReadOnlyOptions } from '../../claude-structured-read-only-options'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'
import { withOwnOrcaReads } from './claude-own-orca-reads'

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'
const RESOLVED = { ORCA_CLI_COMMAND: '/Applications/Orca.app/Contents/Resources/bin/orca' }

/** What a launch's hooks answer for one Bash call, or undefined when none answers. */
async function answer(
  options: ClaudeStructuredSdkOptions,
  toolInput: Record<string, unknown>,
  permissionMode = 'default'
): Promise<string | undefined> {
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const output = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: toolInput,
          tool_use_id: 't',
          session_id: 's',
          transcript_path: '',
          cwd: '/',
          permission_mode: permissionMode
        },
        't',
        { signal: new AbortController().signal }
      )
      const specific = 'hookSpecificOutput' in output ? output.hookSpecificOutput : undefined
      if (specific?.hookEventName === 'PreToolUse' && specific.permissionDecision) {
        return specific.permissionDecision
      }
    }
  }
  return undefined
}

const chat = withOwnOrcaReads({}, RESOLVED, 'darwin')

describe('a Claude chat answers its own Orca reads', () => {
  it.each([
    [`${CLI} bot connectors`, 'allow'],
    [`${CLI} bot item list; ${CLI} bot list && ${CLI} repo list 2>&1`, 'allow'],
    // Writes, other programs, shell syntax, and commands Claude can check itself keep its own answer.
    [`${CLI} bot reply --text 'hi'`, undefined],
    [`${CLI} orchestration reply --id 1 --body 'ok'`, undefined],
    [`${CLI} bot list; rm -rf x`, undefined],
    [`${CLI} bot list; gh pr view 1`, undefined],
    [`${CLI} bot list | sh`, undefined],
    [`sh -lc '${CLI} bot list'`, undefined],
    ['orca bot list', undefined],
    [`echo "exit=\${pipestatus[1]}"`, undefined]
  ])('%s', async (command, decision) => {
    expect(await answer(chat, { command })).toBe(decision)
  })

  it('answers only in modes that would ask', async () => {
    const read = { command: `${CLI} bot list` }
    expect(await answer(chat, read, 'acceptEdits')).toBe('allow')
    for (const mode of ['dontAsk', 'auto', 'plan', 'bypassPermissions']) {
      expect(await answer(chat, read, mode)).toBe(undefined)
    }
  })

  it('leaves a retry outside the sandbox to the owner', async () => {
    const retry = { command: `${CLI} bot list`, dangerouslyDisableSandbox: true }
    expect(await answer(chat, retry)).toBe(undefined)
  })

  it('answers nothing where the variable names no CLI, or on Windows', async () => {
    const read = { command: `${CLI} bot list` }
    expect(await answer(withOwnOrcaReads({}, {}, 'darwin'), read)).toBe(undefined)
    expect(await answer(withOwnOrcaReads({}, RESOLVED, 'win32'), read)).toBe(undefined)
  })

  it('keeps a read-only run refusing writes', async () => {
    const lookAround = withOwnOrcaReads(claudeReadOnlyOptions('look-around'), RESOLVED, 'darwin')
    expect(await answer(lookAround, { command: `${CLI} bot reply --text 'hi'` })).toBe('deny')
  })
})
