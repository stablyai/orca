// The PreToolUse answers Orca sends, checked against the real `claude` CLI on this machine's login.
// Opt in with ORCA_REAL_CLAUDE_CLI_TEST=1; each run spends two short haiku turns in a temp folder.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { REAL_CLAUDE_CLI_TEST_ENV } from './claude-real-cli-test-gate'

const enabled = process.env[REAL_CLAUDE_CLI_TEST_ENV] === '1' && process.platform !== 'win32'
const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

type PreToolUseAnswer = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
  }
}

/** Runs one turn whose Bash call a PreToolUse hook answers with `answer`. */
async function runWithAnswer(
  answer: PreToolUseAnswer
): Promise<{ folder: string; stdout: string }> {
  const folder = mkdtempSync(join(tmpdir(), 'orca-pre-tool-use-'))
  folders.push(folder)
  const hook = join(folder, 'hook.sh')
  writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${JSON.stringify(answer)}'\n`)
  chmodSync(hook, 0o755)
  const settings = join(folder, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hook }] }] }
    })
  )
  const result = await runProcess({
    program: 'claude',
    args: [
      '-p',
      'Run exactly this shell command with the Bash tool: echo ORIGINAL_COMMAND . Then reply with the output you saw, or NOT_RUN and the reason.',
      '--model',
      'haiku',
      // Why: the person's own default may bypass approvals, which would hide the check below.
      '--permission-mode',
      'default',
      '--settings',
      settings
    ],
    cwd: folder,
    timeoutMs: 180_000
  })
  return { folder, stdout: result.stdout }
}

describe('Claude Code honours Orca’s PreToolUse answers', () => {
  it.skipIf(!enabled)(
    'runs updatedInput without permissionDecision',
    async () => {
      const { stdout } = await runWithAnswer({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: 'echo REWRITTEN_BY_HOOK', description: 'echo' }
        }
      })
      expect(stdout).toContain('REWRITTEN_BY_HOOK')
    },
    200_000
  )

  it.skipIf(!enabled)(
    'still asks the person to approve a rewritten call',
    async () => {
      const created = join(tmpdir(), `orca-pre-tool-use-${process.pid}-created`)
      const { stdout } = await runWithAnswer({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: `touch ${created}`, description: 'touch' }
        }
      })
      // -p cannot show the approval, so a call that needs one does not run.
      expect(existsSync(created)).toBe(false)
      expect(stdout).toMatch(/NOT_RUN/)
    },
    200_000
  )

  it.skipIf(!enabled)(
    'refuses a denied call and shows the reason',
    async () => {
      const { stdout } = await runWithAnswer({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'acme.guard: blocked by test'
        }
      })
      expect(stdout).not.toContain('ORIGINAL_COMMAND\n')
      expect(stdout).toMatch(/blocked by test|NOT_RUN/)
    },
    200_000
  )
})
