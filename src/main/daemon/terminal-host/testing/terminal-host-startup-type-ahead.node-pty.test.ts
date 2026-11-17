import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from '../../pty-subprocess/pty-subprocess'
import { TerminalHost } from '../terminal-host'

const ZSH = '/bin/zsh'
const describeZsh = process.platform !== 'win32' && existsSync(ZSH) ? describe : describe.skip
const SESSION_ID = 'startup-type-ahead'
const COMMAND = `bash -c 'read -r line; printf "AGENT_GOT:[%s]\\n" "$line"'`

describeZsh('typing while an agent tab starts', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  async function start(zshrc: string, shellReadyTimeoutMs?: number) {
    const home = mkdtempSync(join(tmpdir(), 'orca-type-ahead-'))
    writeFileSync(join(home, '.zshrc'), zshrc)
    const host = new TerminalHost({ spawnSubprocess: createPtySubprocess })
    let output = ''
    await host.createOrAttach({
      sessionId: SESSION_ID,
      cols: 100,
      rows: 30,
      cwd: home,
      command: COMMAND,
      shellOverride: ZSH,
      shellReadySupported: true,
      ...(shellReadyTimeoutMs ? { shellReadyTimeoutMs } : {}),
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SHELL: ZSH,
        TERM: 'xterm-256color'
      },
      envToDelete: ['ZDOTDIR', 'ORCA_ORIG_ZDOTDIR'],
      streamClient: { onData: (data: string) => (output += data), onExit: () => {} }
    })
    cleanup = async () => {
      await host.dispose()
      rmSync(home, { recursive: true, force: true })
    }
    return { host, output: () => output }
  }

  // A real login shell runs a slow rc before the agent command starts.
  it('delivers keystrokes typed during shell startup to the agent, not the shell', async () => {
    const tab = await start('sleep 0.6\n')
    tab.host.write(SESSION_ID, 'ademarkqz\r')
    await vi.waitFor(() => expect(tab.output()).toContain('AGENT_GOT:[ademarkqz]'), {
      timeout: 8_000
    })
    expect(tab.output()).not.toContain('command not found')
  }, 15_000)

  // The no-line-editor fallback waits out the readiness timeout in a real shell.
  it('still starts the agent once when the shell never reaches a line editor', async () => {
    const tab = await start('unsetopt zle\n', 1_500)
    await vi.waitFor(() => expect(tab.output()).toContain(COMMAND), { timeout: 8_000 })
    tab.host.write(SESSION_ID, 'late\r')
    await vi.waitFor(() => expect(tab.output()).toContain('AGENT_GOT:[late]'), { timeout: 5_000 })
    expect(tab.output().split('AGENT_GOT:[late]').length - 1).toBe(1)
  }, 15_000)
})
