/** STA-2380 (C1 F1): Orca's zsh OSC 133;C hook runs first in `preexec_functions`, so a later user or
 * framework preexec hook prints before the agent exists. Real zsh under the production wrapper, a
 * silent stand-in `claude`, then the captured bytes replayed through the real tui-idle wait. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { getShellLaunchConfig } from '../../../providers/local-pty/local-pty-shell-ready'
import { selectShellStartupFeatures } from '../../../pty/shell-startup/shell-startup-features'
import { hasZsh, ZSH_PATH } from '../../../pty/shell-startup/zsh-startup-hook-pty-harness'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const itWithZsh = hasZsh ? it : it.skip
const POLL_INTERVAL_MS = 2_000
const COMMAND_START = '\x1b]133;C'
// The stand-in's first bytes: Claude turns on palette-change reports before its composer (captures
// from 2.1.291 through 2.1.316; no cutoff is claimed).
const AGENT_FIRST_BYTES = '\x1b[?2031h'
const CLAUDE_COMPOSER_PROMPT = '❯ '
const HOOK_OUTPUT = 'Found existing alias for "claude"'
const CLAUDE_TITLE = '\x1b]2;claude\x07'

const ZSHRC = `autoload -Uz add-zsh-hook
_omz_termsupport_preexec() { print -Pn "\\e]2;claude\\a\\e]1;claude\\a" }
_ysu_preexec() { print -P '%F{yellow}Found existing alias for "claude". You should use: "cc".%f' }
add-zsh-hook preexec _omz_termsupport_preexec
add-zsh-hook preexec _ysu_preexec
`

const STAND_IN = `#!/bin/sh
printf '\\033[?2031h\\033[?2004h'
printf '╭──────────╮\\r\\n│ ${CLAUDE_COMPOSER_PROMPT} │\\r\\n╰──────────╯\\033[?25h'
sleep 60
`

async function captureLaunch(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'orca-preexec-order-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const fixturePath = `${bin}:/usr/bin:/bin`
  mkdirSync(home)
  mkdirSync(bin)
  // Login profiles can reorder PATH, so restore the stand-in before the startup command runs.
  writeFileSync(join(home, '.zshrc'), `export PATH=${quotePosixShell(fixturePath)}\n${ZSHRC}`)
  const standIn = join(bin, 'claude')
  writeFileSync(standIn, STAND_IN)
  chmodSync(standIn, 0o755)

  // The production local launch: markers on, the agent command delivered from the first zle line.
  const features = selectShellStartupFeatures({
    shellPath: ZSH_PATH,
    env: { HOME: home },
    hasStartupCommand: true,
    waitsForShellReady: false,
    emitsStartupIdentity: false
  })
  const launch = getShellLaunchConfig(ZSH_PATH, features, 'claude')
  expect(launch.args, 'the zsh wrapper tree must be usable').not.toBeNull()
  // Resolve user config from the sandbox HOME only.
  const { ORCA_ORIG_ZDOTDIR: _dropped, ...launchEnv } = launch.env

  const proc = pty.spawn(ZSH_PATH, launch.args ?? ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: home,
    env: {
      ...launchEnv,
      PATH: fixturePath,
      HOME: home,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8'
    }
  })
  let output = ''
  let answeredCompinit = false
  const exited = new Promise<void>((resolve) => {
    proc.onExit(() => resolve())
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no composer frame from the stand-in:\n${output}`)),
        25_000
      )
      proc.onData((data) => {
        output += data
        // Ubuntu's global zshrc runs a plain compinit, which stops at its insecure-directory prompt
        // on CI runners before zle exists; answer it as zsh-startup-hook-pty-harness.ts does. The
        // bytes land before Orca's OSC 133;C marker, so stream-offset attribution never sees them.
        if (!answeredCompinit && output.includes('Ignore insecure directories')) {
          answeredCompinit = true
          proc.write('y\r')
        }
        if (output.includes(CLAUDE_COMPOSER_PROMPT)) {
          clearTimeout(timer)
          resolve()
        }
      })
      proc.onExit(() => {
        clearTimeout(timer)
        reject(new Error(`zsh exited before the stand-in painted:\n${output}`))
      })
    })
    return output
  } finally {
    try {
      proc.kill()
    } catch {
      // Already gone.
    }
    // zsh writes history and session files on the way out; remove the tree after it has gone.
    // ast-grep-ignore: test-no-real-time-wait -- the condition is zsh's exit (`exited`); the cap only keeps a shell that ignores SIGHUP from stalling teardown, and rmSync retries cover a late writer.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe.skipIf(process.platform === 'win32')('tui-idle under real zsh preexec hooks', () => {
  let userDataPath = ''
  let previousUserDataPath: string | undefined

  beforeAll(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-preexec-order-wrappers-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterAll(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  itWithZsh(
    'holds through a later preexec hook’s output, then settles on the composer',
    async () => {
      const output = await captureLaunch()
      const markerAt = output.indexOf(COMMAND_START)
      const titleAt = output.indexOf(CLAUDE_TITLE, markerAt)
      const hookAt = output.indexOf(HOOK_OUTPUT, titleAt)
      const agentAt = output.indexOf(AGENT_FIRST_BYTES)
      expect(markerAt).toBeGreaterThanOrEqual(0)
      expect(titleAt).toBeGreaterThan(markerAt)
      expect(hookAt).toBeGreaterThan(titleAt)
      expect(agentAt).toBeGreaterThan(hookAt)

      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'claude',
        launchAgent: 'claude',
        data: ''
      })
      vi.useFakeTimers()
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, output.slice(0, agentAt), Date.now())
      const settled = vi.fn()
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      wait.then(settled, () => {})
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6)
      expect(settled).not.toHaveBeenCalled()

      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, output.slice(agentAt), Date.now())
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    },
    40_000
  )
})
