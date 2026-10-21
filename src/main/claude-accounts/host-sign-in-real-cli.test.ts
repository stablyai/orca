// Real `claude` / `codex` logins as a remote client's sign-in drives them. Opt in with
// ORCA_REAL_CLAUDE_CLI_TEST=1 or ORCA_REAL_CODEX_CLI_TEST=1. Each runs in a throwaway folder and
// never signs in: Claude is sent a bogus code, and the Codex login is cancelled at its prompt.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { runClaudeCommandProcess } from './claude-command-process'
import {
  CLAUDE_PASTED_CODE_REJECTED_MESSAGE,
  runClaudePastedCodeLogin
} from './claude-pasted-code-login'
import { runCodexLoginSession } from '../codex-accounts/codex-login-session'
import type { HostAccountSignInPrompt } from '../../shared/host-account-sign-in-types'

const claudeEnabled = process.env.ORCA_REAL_CLAUDE_CLI_TEST === '1'
const codexEnabled = process.env.ORCA_REAL_CODEX_CLI_TEST === '1'
const posixHost = process.platform !== 'win32'

describe('host sign-in against the real CLIs', () => {
  it.skipIf(!claudeEnabled || !posixHost)(
    'Claude prints its pasted-code link with piped stdin and refuses a bogus code',
    async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-host-sign-in-claude-'))
      const prompts: HostAccountSignInPrompt[] = []
      try {
        const error = await runClaudePastedCodeLogin(
          { windowsPath: folder, linuxPath: null, wslDistro: null },
          runClaudeCommandProcess,
          {
            signal: new AbortController().signal,
            onPrompt: (prompt) => prompts.push(prompt),
            nextCode: async () => 'bogus-code#bogus-state'
          },
          () => {}
        ).then(
          () => null,
          (rejection: unknown) => rejection
        )
        expect(prompts).toHaveLength(1)
        expect(new URL(prompts[0].url).searchParams.get('code')).toBe('true')
        expect(error).toBeInstanceOf(Error)
        expect(error instanceof Error ? error.message : '').toBe(
          CLAUDE_PASTED_CODE_REJECTED_MESSAGE
        )
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.skipIf(!codexEnabled || !posixHost)(
    'Codex device auth prints its page and code, and cancel stops it',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-host-sign-in-codex-'))
      const handle: { cancel: (() => boolean) | null } = { cancel: null }
      const prompted = Promise.withResolvers<{ url: string; userCode: string }>()
      try {
        const login = runCodexLoginSession(home, {
          wslCommand: 'wsl.exe',
          spawn: ({ command, args, env }) =>
            spawnProcess({ program: command, args, env, stdio: ['ignore', 'pipe', 'pipe'] }),
          killProcessTree: (child) => void child.kill(),
          setCancel: (next) => {
            handle.cancel = next
          },
          onAuthUrl: () => {},
          deviceAuth: { onPrompt: prompted.resolve }
        })
        const settledLogin = login.then(
          () => null,
          (rejection: unknown) => rejection
        )
        const prompt = await prompted.promise
        expect(prompt.url).toBe('https://auth.openai.com/codex/device')
        expect(prompt.userCode).toMatch(/^[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+$/)
        expect(handle.cancel?.()).toBe(true)
        expect(await settledLogin).toBeInstanceOf(Error)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    60_000
  )
})
