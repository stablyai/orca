/**
 * Drives a real zsh through a real PTY, to the first prompt and beyond.
 *
 * Why a PTY and not `zsh -i -c '<probe>'`: everything Orca owns now runs from a
 * `precmd` hook, and `-c` never reaches a prompt, so `precmd` never fires. A
 * probe run that way would report the wrapper doing nothing at all — for the
 * right reason, at the wrong question. These tests have to reach a prompt to
 * mean anything.
 *
 * Results come back through a file rather than stdout because a PTY echoes the
 * command being typed, so matching on stdout matches the echo of the probe as
 * readily as its output.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'

export const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0

export const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''

/** OSC sequences the wrapper emits, as the terminal would receive them. */
export const MARKERS = {
  identity: /\]777;orca-shell-start:\d+/,
  ready: ']777;orca-shell-ready',
  promptStart: ']133;A',
  commandStart: ']133;C',
  commandDone: /\]133;D;\d+/
} as const

export type ZshPtyRun = {
  /** Everything the terminal received, escape sequences intact. */
  output: string
  /** `name=<value>` pairs the probe wrote, parsed. */
  values: Record<string, string>
  /**
   * True when the shell exited before reaching a prompt — what a user `.zshenv`
   * that calls `exit` produces. A real outcome to compare, not a failure.
   */
  exitedBeforePrompt: boolean
}

export type ZshPtyOptions = {
  env: Record<string, string>
  /** Shell variables to report, e.g. `['HISTFILE', 'ZDOTDIR']`. */
  report?: readonly string[]
  /** Commands to run at the prompt before reporting. */
  commands?: readonly string[]
  cwd?: string
  timeoutMs?: number
}

/**
 * Why the value syntax is `NAME=<...>`: an unset variable and an empty one must
 * be distinguishable, and the delimiters survive a terminal's line wrapping.
 *
 * Why the trailing `;` before `}`: a config that leaves the shell in sh
 * emulation needs it, and without it zsh sits in a `cursh>` continuation
 * waiting for the group to close — which reads exactly like a hung wrapper.
 */
function buildProbe(report: readonly string[], resultPath: string): string {
  const prints = report.map((name) => `print -r -- "${name}=<\${${name}:-UNSET}>";`).join(' ')
  return `{ ${prints} } > ${JSON.stringify(resultPath)}`
}

function parseValues(resultPath: string): Record<string, string> {
  if (!existsSync(resultPath)) {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of readFileSync(resultPath, 'utf8').split('\n')) {
    const match = /^(\w+)=<(.*)>$/.exec(line.trim())
    if (match) {
      values[match[1]] = match[2]
    }
  }
  return values
}

/**
 * Runs an interactive login zsh under a PTY, waits for its first prompt, runs
 * the requested commands, and reports the requested shell variables.
 *
 * Readiness is detected by a sentinel baked into PS1 rather than a fixed sleep,
 * so a slow prompt framework makes the run slower, never flaky.
 */
export async function runZshPty(options: ZshPtyOptions): Promise<ZshPtyRun> {
  const sentinel = '@@ORCA-PTY-READY@@'
  const workDir = mkdtempSync(join(tmpdir(), 'orca-zsh-pty-'))
  const resultPath = join(workDir, 'probe.txt')
  const timeoutMs = options.timeoutMs ?? 20_000

  const proc = pty.spawn(ZSH_PATH, ['-l', '-i'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    cwd: options.cwd ?? workDir,
    env: {
      ...options.env,
      // Why the sentinel is env-borne: the prompt is overwritten from the PTY
      // below, and it has to survive whatever prompt the user's config installs.
      ORCA_PTY_SENTINEL: sentinel
    }
  })

  let output = ''
  let answeredCompinit = false
  let lastDataAt = Date.now()
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  proc.onData((data) => {
    output += data
    lastDataAt = Date.now()
    // Why this is answered rather than configured away: a host whose global
    // zshrc runs `compinit` over directories it considers insecure — CI runners
    // do — stops startup and ASKS, and a real PTY will sit at that question
    // until the timeout. A pipe-backed `zsh -i -c` never saw it. ZSH_DISABLE_COMPFIX
    // does not help: that is an oh-my-zsh convention, and plain `compinit` (which
    // is what asks) ignores it. Answering keeps the shell on the path a user
    // pressing `y` would take, and both arms of a comparison get the same
    // treatment, so it cannot tilt one against the other.
    if (!answeredCompinit && output.includes('Ignore insecure directories')) {
      answeredCompinit = true
      proc.write('y\r')
    }
    if (resolveReady && output.includes(sentinel)) {
      resolveReady()
      resolveReady = undefined
    }
  })
  let hasExited = false
  const exited = new Promise<void>((resolve) => {
    proc.onExit(() => {
      hasExited = true
      resolve()
    })
  })

  let timer: ReturnType<typeof setTimeout> | null = null
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for the zsh prompt:\n${output}`)),
      timeoutMs
    )
  })

  /**
   * Resolves once the shell has produced nothing for `quietMs`, or exited.
   *
   * Why quiescence and not a fixed sleep before typing: startup output has to
   * finish before the PS1 line is typed, or a shell still asking a question
   * (compinit, above) eats it as the answer. A fast host waits milliseconds; a
   * slow prompt framework waits as long as it needs.
   */
  async function waitForQuiet(quietMs: number): Promise<void> {
    while (!hasExited) {
      const idleFor = Date.now() - lastDataAt
      if (idleFor >= quietMs) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, quietMs - idleFor))
    }
  }

  try {
    await Promise.race([waitForQuiet(250), exited, timedOut])
    if (hasExited) {
      return { output, values: parseValues(resultPath), exitedBeforePrompt: true }
    }
    // Why the prompt is replaced rather than parsed: it only has to carry the
    // sentinel from the SECOND prompt on — the first is where the deferred hook
    // does its work, and that has already happened by now.
    //
    // Why PS1 and not PROMPT: a config that leaves the shell in sh emulation
    // renders PS1, where PROMPT is just an ordinary variable. In zsh's own mode
    // the two name the same parameter, so PS1 covers both.
    proc.write(`PS1="$ORCA_PTY_SENTINEL"\r`)
    // Why `exited` is raced here too: a user .zshenv that calls `exit` never
    // reaches a prompt, and that is an outcome worth comparing rather than a
    // twenty-second timeout.
    await Promise.race([ready, exited, timedOut])
    if (hasExited) {
      return { output, values: parseValues(resultPath), exitedBeforePrompt: true }
    }
    for (const command of options.commands ?? []) {
      proc.write(`${command}\r`)
    }
    if (options.report?.length) {
      proc.write(`${buildProbe(options.report, resultPath)}\r`)
    }
    proc.write('exit\r')
    await Promise.race([exited, timedOut])
    return { output, values: parseValues(resultPath), exitedBeforePrompt: false }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    try {
      proc.kill()
    } catch {
      // Already exited normally.
    }
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** Writes a throwaway $HOME with the given zsh startup files. */
export function makeZshHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-zsh-home-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(home, name), content)
  }
  return home
}
