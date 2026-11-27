import { describe, expect, it } from 'vitest'
import { claudeReadOnlyOptions } from '../../claude-structured-read-only-options'
import { withOwnOrcaReads } from './claude-own-orca-reads'

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'
const RESOLVED = { ORCA_CLI_COMMAND: '/Applications/Orca.app/Contents/Resources/bin/orca' }

/** What the launch's hooks answer for one Bash call: 'allow', or undefined when none answers. */
async function answer(
  toolInput: Record<string, unknown>,
  env: Record<string, string> = RESOLVED,
  platform: NodeJS.Platform = 'darwin'
): Promise<string | undefined> {
  const options = withOwnOrcaReads({}, env, platform)
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
          cwd: '/'
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
    expect(await answer({ command })).toBe(decision)
  })

  it('leaves a retry outside the sandbox to the owner', async () => {
    expect(await answer({ command: `${CLI} bot list`, dangerouslyDisableSandbox: true })).toBe(
      undefined
    )
  })

  it('answers nothing where the variable names no CLI, or on Windows', async () => {
    expect(await answer({ command: `${CLI} bot list` }, {})).toBe(undefined)
    expect(await answer({ command: `${CLI} bot list` }, RESOLVED, 'win32')).toBe(undefined)
  })

  it("keeps a read-only run's own hook", () => {
    const readOnly = claudeReadOnlyOptions('look-around')
    expect(withOwnOrcaReads(readOnly, RESOLVED, 'darwin').hooks).toBe(readOnly.hooks)
  })
})
