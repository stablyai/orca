import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'
import type { Session } from './session'
const COMMAND = "printf 'AGENT_%s\\n' STARTED"

export async function launchPromptFixture({
  shell,
  slow,
  legacy
}: {
  shell: string
  slow: boolean
  legacy: boolean
}): Promise<{ output: string; ms: number }> {
  const root = mkdtempSync(join(tmpdir(), 'orca-startup-latency-'))
  const bash = shell.endsWith('bash')
  const pause = slow ? 'sleep 0.6\n' : ''
  const prompt = slow ? "PS1='$(sleep 0.3)prompt> '\n" : "PS1='prompt> '\n"
  writeFileSync(
    join(root, bash ? '.bash_profile' : '.zshrc'),
    `${pause}${bash ? '' : 'setopt PROMPT_SUBST\n'}${prompt}`
  )
  process.env.HOME = root
  process.env.ZDOTDIR = root
  process.env.ORCA_ORIG_ZDOTDIR = root
  setAppEnvironment({
    getPath: () => root,
    getAppPath: () => root,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit() {},
    exit: (code) => process.exit(code),
    getAppMetrics: () => []
  })
  const { createPtySubprocess } = await import('./pty-subprocess')
  const { Session } = await import('./session')
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
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(readinessEvents, [])
  }
}
