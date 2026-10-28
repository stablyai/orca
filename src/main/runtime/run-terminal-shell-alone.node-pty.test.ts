import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from '../daemon/pty-subprocess'
import { Session } from '../daemon/session'
import { confirmRootShellAloneFromProcessTable } from './run-terminal-shell-alone'

// A real daemon session on a real PTY: the process table, not a fake, decides.
const SHELL = process.platform === 'win32' ? null : (['/bin/bash'].find(existsSync) ?? null)
let session: Session | undefined
let root: string | undefined

async function shellThatRan(command: string, settledMarker: string): Promise<Session> {
  root = mkdtempSync(join(tmpdir(), 'orca-run-shell-'))
  writeFileSync(join(root, '.bash_profile'), "PS1='prompt> '\n")
  vi.stubEnv('HOME', root)
  const subprocess = await createPtySubprocess({
    sessionId: 'run-shell',
    cols: 120,
    rows: 30,
    cwd: root,
    shellOverride: SHELL!,
    env: { HOME: root, SHELL: SHELL!, TERM: 'xterm-256color' }
  })
  session = new Session({
    sessionId: 'run-shell',
    cols: 120,
    rows: 30,
    subprocess,
    shellReadySupported: false
  })
  let output = ''
  session.attachClient({ onExit: () => {}, onData: (data) => (output += data) })
  await vi.waitFor(() => expect(output).toContain('prompt> '), { timeout: 5000 })
  session.write(`${command}\n`)
  await vi.waitFor(() => expect(output).toContain(settledMarker), { timeout: 5000 })
  return session
}

afterEach(async () => {
  if (session) {
    await session.forceKillAndWaitForExit(3000)
    session.dispose()
    session = undefined
  }
  vi.unstubAllEnvs()
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(!SHELL)('run terminal shell-alone proof on a real daemon session', () => {
  it('proves the shell alone after an agent command that is not installed', async () => {
    const shell = await shellThatRan('goose-not-installed run', 'command not found')
    await vi.waitFor(
      async () => expect(await confirmRootShellAloneFromProcessTable(shell.pid)).toBe(true),
      {
        timeout: 5000
      }
    )
    // The daemon's ownership flag never turns 'shell' for a plain failed command.
    expect(await shell.confirmShellForeground()).toBe(false)
  })

  it('proves the shell alone after an agent that ran and exited', async () => {
    const shell = await shellThatRan("sh -c 'printf AGENT_%s DONE'", 'AGENT_DONE')
    await vi.waitFor(
      async () => expect(await confirmRootShellAloneFromProcessTable(shell.pid)).toBe(true),
      {
        timeout: 5000
      }
    )
  })

  it('never proves it while an agent still runs in the shell', async () => {
    const shell = await shellThatRan("sh -c 'printf AGENT_%s UP; sleep 30'", 'AGENT_UP')
    expect(await confirmRootShellAloneFromProcessTable(shell.pid)).toBe(false)
  })
})
