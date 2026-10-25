/**
 * Real-zsh proof for the typed launch lines `startup-line-prompt-carry.ts` lets a prompt ride: a
 * multi-line line whose every line fits the per-line budget, up to the whole-line budget, reaches
 * zsh intact through Orca's own wrapper, ready marker and startup write.
 *
 * Why a slow user config too: the write is released 1.5 s after spawn even without the marker, and
 * then lands while the terminal is still line-buffered, where macOS keeps at most MAX_CANON bytes of
 * one line. The per-line budget is what survives that; a single 1.1 KB line did not.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createShellStartupOutputScanState,
  scanShellStartupOutput
} from '../shell-startup-output-scanner'
import { selectShellStartupFeatures } from '../shell-startup-features'
import { isBracketedPasteSafeShell } from '../../shared/startup-command-submission'
import {
  TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES,
  ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES
} from '../../shared/startup-line-prompt-carry'
import {
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './local-pty-shell-ready-test-harness'

function findZsh(): string {
  if (process.platform === 'win32') {
    return ''
  }
  return (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout ?? '').trim()
}

const ZSH_PATH = findZsh()

/** Lines of prompt text, each `perLine` bytes. */
function promptLines(lineCount: number, perLine: number): string {
  const words = 'Fix the failing checks on this branch, then explain what changed and why.'
  return Array.from({ length: lineCount }, (_unused, index) => {
    let line = `L${index}:`
    while (line.length < perLine) {
      line += ` ${words}`
    }
    return line.slice(0, perLine)
  }).join('\n')
}

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-typed-line-home-'))
  setTestUserDataPath(mkdtempSync(join(tmpdir(), 'orca-typed-line-ud-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

restoreUserDataPathAfterEach()

/** Types `printf '%s' '<text>' > out` the way a local pane types a launch line; returns what ran. */
async function typeIntoZsh(text: string, userConfigSeconds: number): Promise<string | null> {
  if (userConfigSeconds > 0) {
    writeFileSync(join(home, '.zshrc'), `sleep ${userConfigSeconds}\n`)
  }
  const out = join(home, 'out.txt')
  const done = join(home, 'done.txt')
  const { ensureShellReadyWrappers } = await import('./local-pty-shell-ready-wrapper-generation')
  const { getShellLaunchConfig } = await import('./local-pty-shell-ready')
  const { writeStartupCommandWhenShellReady, STARTUP_COMMAND_READY_MAX_WAIT_MS } =
    await import('./local-pty-shell-ready-startup-command')
  ensureShellReadyWrappers()
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: home }
  const launch = getShellLaunchConfig(
    ZSH_PATH,
    selectShellStartupFeatures({
      shellPath: ZSH_PATH,
      env,
      hasStartupCommand: true,
      waitsForShellReady: true,
      emitsStartupIdentity: false
    })
  )
  expect(launch.supportsReadyMarker).toBe(true)
  const proc = pty.spawn(ZSH_PATH, launch.args ?? [], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    cwd: home,
    // Why ORCA_ORIG_ZDOTDIR: the user's config is read from the sandbox home, not the real one.
    env: { ...env, ...launch.env, ORCA_ORIG_ZDOTDIR: home, TERM: 'xterm-256color' }
  })
  const scan = createShellStartupOutputScanState()
  let resolveReady: ((signal: { postMarkerBytesObserved: boolean }) => void) | null = null
  const ready = new Promise<{ postMarkerBytesObserved: boolean }>((resolve) => {
    resolveReady = resolve
  })
  // The provider's cap (local-pty-shell-readiness-session.ts): a later marker releases the write.
  const cap = setTimeout(() => {
    resolveReady?.({ postMarkerBytesObserved: false })
    resolveReady = null
  }, STARTUP_COMMAND_READY_MAX_WAIT_MS)
  proc.onData((data) => {
    if (resolveReady && scanShellStartupOutput(scan, data).ready) {
      resolveReady({ postMarkerBytesObserved: true })
      resolveReady = null
    }
  })
  writeStartupCommandWhenShellReady(
    ready,
    proc,
    `printf '%s' '${text}' > '${out}'; printf ok > '${done}'`,
    () => {},
    {
      bracketedPasteSafe: isBracketedPasteSafeShell({
        shellName: 'zsh',
        waitsForShellReady: launch.supportsReadyMarker === true
      })
    }
  )
  const deadline = Date.now() + 20_000 + userConfigSeconds * 1000
  while (!existsSync(done) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  clearTimeout(cap)
  const ran = existsSync(out) ? readFileSync(out, 'utf8') : null
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  proc.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  return ran
}

describe.skipIf(!ZSH_PATH)('a multi-line launch line typed into zsh', () => {
  // Lines at the per-line budget, as many as the whole-line budget leaves room for.
  const perLine = TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES - 1
  const text = promptLines(
    Math.floor((ZSH_MULTI_LINE_STARTUP_LINE_BUDGET_BYTES - 200) / (perLine + 1)),
    perLine
  )

  it('arrives whole through the ready barrier', async () => {
    expect(await typeIntoZsh(text, 0)).toBe(text)
  }, 60_000)

  it('arrives whole when the user config outlasts the barrier and the write lands early', async () => {
    expect(await typeIntoZsh(text, 3)).toBe(text)
  }, 60_000)
})
