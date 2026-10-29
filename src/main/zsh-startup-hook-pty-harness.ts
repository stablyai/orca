/** Reach a real PTY prompt so precmd runs; collect probe values in a file to avoid matching echoed commands. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'

export const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0

export const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''

export const MARKERS = {
  identity: /\]777;orca-shell-start:\d+/,
  ready: ']777;orca-shell-ready',
  promptStart: ']133;A',
  commandStart: ']133;C',
  commandDone: /\]133;D;\d+/
} as const

export type ZshPtyRun = {
  output: string
  values: Record<string, string>
  /** Early shell exit is a valid outcome, as when a user .zshenv calls exit. */
  exitedBeforePrompt: boolean
}

export type ZshPtyOptions = {
  env: Record<string, string>
  report?: readonly string[]
  commands?: readonly string[]
  cwd?: string
  timeoutMs?: number
}

/** Delimit values for terminal wrapping; the trailing semicolon closes the group under sh emulation. */
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

/** A second-prompt sentinel proves readiness; initial output quiescence only gates the first input. */
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
      // Keep the sentinel in env so it survives the user's prompt replacement.
      ORCA_PTY_SENTINEL: sentinel
    }
  })

  let output = ''
  let answeredCompinit = false
  let lastDataAt: number | null = null
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  proc.onData((data) => {
    output += data
    lastDataAt = Date.now()
    // Plain compinit ignores ZSH_DISABLE_COMPFIX; answer its insecure-directory prompt identically in both runs.
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

  /** Wait for output to settle before typing so startup questions cannot consume the probe as their answer. */
  async function waitForQuiet(quietMs: number): Promise<void> {
    while (!hasExited) {
      // Silence before the first output is not evidence that startup has settled.
      const idleFor = lastDataAt === null ? 0 : Date.now() - lastDataAt
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
    // Replace the second prompt, after deferred init; PS1 works in both zsh and sh emulation.
    proc.write(`PS1="$ORCA_PTY_SENTINEL"\r`)
    // A .zshenv exit is an observable outcome, not a prompt timeout.
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

export function makeZshHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-zsh-home-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(home, name), content)
  }
  return home
}
