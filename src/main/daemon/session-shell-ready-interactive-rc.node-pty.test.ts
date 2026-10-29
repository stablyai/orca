import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'

const STARTUP_OUTPUT = 'ORCA_STARTUP_COMMAND_RAN'
const SECRET = 'hunter2'
// A startup file that asks for a passphrase before the shell can reach its prompt, the shape a
// `keychain`/`ssh-add` hook has.
const PASSPHRASE_PROMPT = `printf 'Enter passphrase: '; read -rs PASS; printf '\\nRC_GOT:%s\\n' "$PASS"\n`

const SHELLS = [
  { shellPath: '/bin/zsh', startupFile: '.zshrc', prompt: PASSPHRASE_PROMPT },
  { shellPath: '/bin/bash', startupFile: '.bash_profile', prompt: PASSPHRASE_PROMPT },
  {
    shellPath: '/bin/zsh',
    startupFile: '.zshrc',
    prompt: `PASS=''; vared -p 'Enter passphrase: ' PASS; print -r -- "RC_GOT:$PASS"\n`
  },
  {
    shellPath: '/bin/zsh',
    startupFile: '.zshrc',
    prompt: `unsetopt zle nomatch\n${PASSPHRASE_PROMPT}`,
    timeout: true
  }
].filter(
  ({ shellPath }) =>
    process.platform !== 'win32' && spawnSync(shellPath, ['--version']).status === 0
)

async function waitFor(isDone: () => boolean, timeoutMs: number): Promise<void> {
  await vi.waitFor(() => expect(isDone()).toBe(true), { timeout: timeoutMs, interval: 20 })
}

async function startShell(
  shellPath: string,
  startupFile: string,
  shellReadyTimeoutMs: number,
  prompt: string,
  command = `printf 'ORCA_STARTUP_%s\\n' COMMAND_RAN\r`
): Promise<{ session: Session; output: () => string; cleanup: () => Promise<void> }> {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-zsh-interactive-init-restore-'))
  writeFileSync(join(tempHome, startupFile), prompt)
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const subprocess = await createPtySubprocess({
    sessionId: `interactive-rc-${startupFile}`,
    cols: 80,
    rows: 24,
    cwd: tempHome,
    command,
    shellOverride: shellPath,
    env: {
      HOME: tempHome,
      XDG_CONFIG_HOME: join(tempHome, '.config'),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SHELL: shellPath,
      TERM: 'xterm-256color'
    },
    envToDelete: ['ZDOTDIR', 'ORCA_ORIG_ZDOTDIR']
  })
  const session = new Session({
    sessionId: `interactive-rc-${startupFile}`,
    cols: 80,
    rows: 24,
    subprocess,
    shellReadySupported: true,
    shellReadyTimeoutMs
  })
  let output = ''
  session.attachClient({ onData: (data) => (output += data), onExit: () => {} })
  session.writeStartupCommand(buildStartupCommandSubmission(command, { bracketedPasteSafe: true }))
  return {
    session,
    output: () => output,
    cleanup: async () => {
      try {
        await session.forceKillAndWaitForExit(3_000)
      } catch {}
      session.dispose()
      warnSpy.mockRestore()
      rmSync(tempHome, { recursive: true, force: true })
    }
  }
}

describe.each(SHELLS)(
  'startup question ($shellPath $prompt)',
  ({ shellPath, startupFile, prompt, timeout }) => {
    it(
      'accepts the answer before readiness and runs startup once',
      async () => {
        const command = timeout
          ? `[[ -o nonomatch ]] && printf 'ORCA_STARTUP_%s\\n' COMMAND_RAN\r`
          : undefined
        const running = await startShell(
          shellPath,
          startupFile,
          timeout ? 2_000 : 15_000,
          prompt,
          command
        )
        try {
          await waitFor(() => running.output().includes('Enter passphrase:'), 5_000)
          expect(running.session.shellState).toBe('pending')
          expect(running.output()).not.toContain(STARTUP_OUTPUT)
          running.session.write(`${SECRET}\r`)
          await waitFor(() => running.output().includes(`RC_GOT:${SECRET}`), 1_000)
          await waitFor(() => running.output().includes(STARTUP_OUTPUT), 5_000)
          expect(running.session.shellState).toBe(timeout ? 'timed_out' : 'ready')
          expect(running.output().split(STARTUP_OUTPUT).length - 1).toBe(1)
          expect(running.output()).not.toContain(
            'no such hash table element: __orca_deferred_sched_init'
          )
        } finally {
          await running.cleanup()
        }
      },
      // Real shell startup and the no-ZLE readiness fallback must complete before cleanup.
      15_000
    )
  }
)
