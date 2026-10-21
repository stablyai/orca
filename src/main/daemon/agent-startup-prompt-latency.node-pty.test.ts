import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'

const SHELLS = process.platform === 'win32' ? [] : ['/bin/bash', '/bin/zsh'].filter(existsSync)
const COMMAND = "printf 'AGENT_%s\\n' STARTED"

async function launch(
  shell: string,
  slow: boolean,
  legacy = false
): Promise<{ output: string; ms: number }> {
  const root = mkdtempSync(join(tmpdir(), 'orca-startup-latency-'))
  const bash = shell.endsWith('bash')
  const pause = slow ? 'sleep 0.6\n' : ''
  const prompt = slow ? "PS1='$(sleep 0.3)prompt> '\n" : "PS1='prompt> '\n"
  writeFileSync(
    join(root, bash ? '.bash_profile' : '.zshrc'),
    `${pause}${bash ? '' : 'setopt PROMPT_SUBST\n'}${prompt}`
  )
  vi.stubEnv('HOME', root)
  vi.stubEnv('ZDOTDIR', root)
  vi.stubEnv('ORCA_ORIG_ZDOTDIR', root)
  let session: Session | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let legacyTimer: ReturnType<typeof setTimeout> | undefined
  const readinessEvents: string[] = []
  const started = performance.now()
  try {
    const subprocess = await createPtySubprocess({
      sessionId: 'startup-latency',
      cols: 120,
      rows: 30,
      cwd: root,
      shellOverride: shell,
      command: COMMAND,
      env: { HOME: root, SHELL: shell, TERM: 'xterm-256color' }
    })
    session = new Session({
      sessionId: 'startup-latency',
      cols: 120,
      rows: 30,
      subprocess,
      shellReadySupported: !legacy,
      reportReadinessEvent: (event) => readinessEvents.push(event)
    })
    const active = session
    return await new Promise((resolve, reject) => {
      let output = ''
      timer = setTimeout(
        () => reject(new Error(`Startup timed out: ${JSON.stringify(output)}`)),
        5000
      )
      active.attachClient({
        onExit: () => {},
        onData: (data) => {
          output += data
          if (output.includes('AGENT_STARTED')) {
            resolve({ output, ms: performance.now() - started })
          }
        }
      })
      if (legacy) {
        legacyTimer = setTimeout(() => active.write(`${COMMAND}\n`), 300)
      } else {
        active.write(`${COMMAND}\n`)
      }
    })
  } finally {
    clearTimeout(timer)
    clearTimeout(legacyTimer)
    if (session) {
      await session.forceKillAndWaitForExit(3000)
      session.dispose()
    }
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
    expect(readinessEvents).toEqual([])
  }
}

describe('agent startup at the rendered shell prompt', () => {
  afterEach(() => vi.unstubAllEnvs())
  it.each(SHELLS)(
    '%s displays the command once after slow startup and prompt expansion',
    async (shell) => {
      const before = await launch(shell, true, true)
      expect(before.output.split(COMMAND)).toHaveLength(3)
      const result = await launch(shell, true)
      expect(result.output).not.toContain('orca-shell-ready')
      expect(result.output.split(COMMAND)).toHaveLength(2)
      expect(result.output.indexOf('prompt> ')).toBeLessThan(result.output.indexOf(COMMAND))
    }
  )

  it.skipIf(!process.env.ORCA_STARTUP_BENCH || SHELLS.length === 0)(
    'compares legacy input timing with prompt delivery',
    async () => {
      for (const shell of SHELLS) {
        for (const slow of [false, true]) {
          const legacy: number[] = []
          const current: number[] = []
          for (let i = 0; i < 5; i++) {
            legacy.push((await launch(shell, slow, true)).ms)
            const result = await launch(shell, slow)
            expect(result.output).not.toContain('orca-shell-ready')
            expect(result.output.split(COMMAND)).toHaveLength(2)
            current.push(result.ms)
          }
          const result = JSON.stringify({ shell, slow, legacy, current })
          if (process.env.ORCA_STARTUP_BENCH_OUTPUT) {
            appendFileSync(process.env.ORCA_STARTUP_BENCH_OUTPUT, `${result}\n`)
          }
          console.log(result)
        }
      }
    },
    60_000
  )
})
