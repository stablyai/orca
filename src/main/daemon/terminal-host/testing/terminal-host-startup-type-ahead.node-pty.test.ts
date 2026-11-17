import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from '../../pty-subprocess/pty-subprocess'
import { TerminalHost } from '../terminal-host'

const ZSH = '/bin/zsh'
const describeZsh = process.platform !== 'win32' && existsSync(ZSH) ? describe : describe.skip
const SESSION_ID = 'startup-type-ahead'
// The split marker counts real starts; a typed fallback echoes the command text more than once.
const COMMAND = `bash -c 'printf "AGENT_%s\\n" STARTED; read -r line; printf "AGENT_GOT:[%s]\\n" "$line"'`
// Past the typed-line budget, so the launch is staged as a short script invocation.
const LONG_COMMAND = `${COMMAND} # ${'x'.repeat(2_000)}`

describeZsh('typing while an agent tab starts', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  async function start(zshrc: string, command = COMMAND, shellReadyTimeoutMs?: number) {
    const home = mkdtempSync(join(tmpdir(), 'orca-type-ahead-'))
    writeFileSync(join(home, '.zshrc'), zshrc)
    const host = new TerminalHost({ spawnSubprocess: createPtySubprocess })
    let output = ''
    await host.createOrAttach({
      sessionId: SESSION_ID,
      cols: 100,
      rows: 30,
      cwd: home,
      command,
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
  it.each([
    ['a short launch line', COMMAND],
    ['a staged long launch line', LONG_COMMAND]
  ])(
    'delivers keystrokes typed during shell startup to %s, not the shell',
    async (_label, command) => {
      const tab = await start('sleep 0.6\n', command)
      tab.host.write(SESSION_ID, 'ademarkqz\r')
      await vi.waitFor(() => expect(tab.output()).toContain('AGENT_GOT:[ademarkqz]'), {
        timeout: 8_000
      })
      expect(tab.output()).not.toContain('command not found')
      expect(tab.output()).not.toContain('x'.repeat(100))
    },
    15_000
  )

  // Real shells; the late-marker case outlasts a shortened readiness timeout.
  it.each([
    ['the shell never reaches a line editor', 'unsetopt zle\n', undefined],
    [
      "the user's line-init widget fails under err_return",
      'setopt err_return\norca_test_init() { false }\nzle -N zle-line-init orca_test_init\n',
      undefined
    ],
    ['shell startup outlasts the readiness timeout', 'sleep 1.5\n', 500],
    [
      'the profile execs a fresh shell',
      'if [[ -z "${ORCA_TEST_REEXEC:-}" ]]; then export ORCA_TEST_REEXEC=1; exec /bin/zsh -l -i; fi\n',
      1_500
    ]
  ])(
    'starts the agent exactly once when %s',
    async (_label, zshrc, shellReadyTimeoutMs) => {
      const tab = await start(zshrc, COMMAND, shellReadyTimeoutMs)
      await vi.waitFor(() => expect(tab.output()).toContain('AGENT_STARTED'), { timeout: 8_000 })
      tab.host.write(SESSION_ID, 'late\r')
      await vi.waitFor(() => expect(tab.output()).toContain('AGENT_GOT:[late]'), {
        timeout: 5_000
      })
      expect(tab.output().split('AGENT_STARTED').length - 1).toBe(1)
      expect(tab.output()).not.toContain('command not found')
    },
    15_000
  )

  // A real shell re-execs itself, and the host waits out the post-ready claim grace.
  it('starts the agent exactly once when a line-init hook execs a fresh shell after the ready marker', async () => {
    const tab = await start(
      'orca_test_reexec() { if [[ -z "${ORCA_TEST_REEXEC:-}" ]]; then export ORCA_TEST_REEXEC=1; exec /bin/zsh -l -i; fi }\nzle -N zle-line-init orca_test_reexec\n'
    )
    await vi.waitFor(() => expect(tab.output()).toContain('AGENT_STARTED'), { timeout: 10_000 })
    expect(tab.output().split('AGENT_STARTED').length - 1).toBe(1)
  }, 15_000)
})
