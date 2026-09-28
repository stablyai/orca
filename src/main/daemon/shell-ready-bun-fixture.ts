import { existsSync } from 'node:fs'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput
} from '../shell-startup-output-scanner'
const SHELL_READY_MARKER_OUTPUT = '\x1b]777;orca-shell-ready\x07'
/** Minimal xterm.js-shaped answers to the capability queries fish emits at startup
 *  and again around every prompt. */
const TERMINAL_QUERY_REPLIES: readonly (readonly [string, string])[] = [
  ['\x1b[0c', '\x1b[?6c'], // primary device attributes
  ['\x1b[?u', '\x1b[?0u'], // kitty keyboard flags
  ['\x1b[6n', '\x1b[1;1R'], // cursor position report
  ['\x1b]11;?', '\x1b]11;rgb:0000/0000/0000\x1b\\'], // background colour
  ['\x1bP+q', '\x1bP0+r\x1b\\'] // XTGETTCAP (unsupported)
]

/** Derived, not hardcoded: a shorter carry than the longest query would silently
 *  stop matching sequences split across two PTY chunks. */
const QUERY_CARRY_LEN = Math.max(...TERMINAL_QUERY_REPLIES.map(([query]) => query.length))

// Why: the shell-ready marker fires from zle-line-init only on a real TTY, so spawn through a terminal rather than a pipe.
export async function runInteractiveZshLogin(args: {
  tempHome: string
  wrapperZdotdir: string
  expected: string[]
}): Promise<string> {
  // Why: -o noglobalrcs skips /etc/zsh/*, whose insecure fpath dirs make compinit block on a [y/n] prompt before the marker fires.
  const proc = spawnBunPty({
    file: 'zsh',
    args: ['-o', 'noglobalrcs', '-l'],
    cols: 80,
    rows: 24,
    cwd: args.tempHome,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: args.tempHome,
      TERM: 'xterm-256color',
      ZDOTDIR: args.wrapperZdotdir,
      ORCA_ORIG_ZDOTDIR: args.tempHome,
      ORCA_ZSHENV_SOURCE_DIR: args.tempHome,
      ORCA_SHELL_FEATURES: 'ready'
    }
  })
  let output = ''
  let settle = (): void => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const deadline = setTimeout(settle, 10_000)
  proc.onData((chunk) => {
    output += chunk
    if (args.expected.every((value) => output.includes(value))) {
      settle()
    }
  })
  await done
  clearTimeout(deadline)
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  proc.kill()
  await exited
  proc.destroy()
  return output
}

// Why: exercise an arbitrary interactive zsh rc (own ZDOTDIR, no wrapper) so a test can source the marker block directly.
export async function runInteractiveZshRc(args: {
  zdotdir: string
  expected: string[]
}): Promise<string> {
  // Why: -o noglobalrcs skips /etc/zsh/* so the CI runner's global compinit can't block on an insecure-directory [y/n] prompt.
  const proc = spawnBunPty({
    file: 'zsh',
    args: ['-o', 'noglobalrcs', '-i'],
    cols: 80,
    rows: 24,
    cwd: args.zdotdir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: args.zdotdir,
      TERM: 'xterm-256color',
      ZDOTDIR: args.zdotdir,
      ORCA_SHELL_FEATURES: 'ready'
    }
  })
  let output = ''
  let settle = (): void => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const deadline = setTimeout(settle, 10_000)
  proc.onData((chunk) => {
    output += chunk
    if (args.expected.every((value) => output.includes(value))) {
      settle()
    }
  })
  await done
  clearTimeout(deadline)
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  proc.kill()
  await exited
  proc.destroy()
  return output
}

export async function runFishShellReadyFixture({
  binary,
  tempHome,
  config,
  sentinel,
  erased,
  stillRegistered
}: {
  binary: string
  tempHome: string
  config: { args: string[] | null; env: Record<string, string> }
  sentinel: string
  erased: string
  stillRegistered: string
}): Promise<{ output: string; scannedOutput: string }> {
  const proc = spawnBunPty({
    file: binary,
    args: config.args ?? [],
    cols: 80,
    rows: 24,
    cwd: tempHome,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tempHome,
      TERM: 'xterm-256color',
      ...config.env
    }
  })
  let output = ''
  let scannedOutput = ''
  const startupScanState = createShellStartupOutputScanState()
  let commandWritten = false
  let erasureProbeWritten = false
  let queryCarry = ''
  let settle = (): void => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const deadline = setTimeout(settle, 10_000)
  // Why: settling on the first sentinel observes only one post-marker prompt,
  // so a marker that never erased itself still looks single. Drive a second
  // command and settle on its result, which also probes the erase directly.
  const sentinelPoll = setInterval(() => {
    if (commandWritten && !erasureProbeWritten && existsSync(sentinel)) {
      erasureProbeWritten = true
      proc.write(
        `functions -q __orca_shell_ready_marker; and touch ${stillRegistered}; or touch ${erased}\n`
      )
      return
    }
    if (erasureProbeWritten && (existsSync(erased) || existsSync(stillRegistered))) {
      settle()
    }
  }, 50)
  proc.onData((chunk) => {
    output += chunk
    scannedOutput += scanShellStartupOutput(startupScanState, chunk).output
    // Why: fish stalls its first prompt 10s waiting on these and re-queries
    // each prompt, so answer every occurrence — an unanswered query makes
    // fish swallow the post-marker command as its reply.
    const carriedLength = queryCarry.length
    const scan = queryCarry + chunk
    queryCarry = scan.slice(-QUERY_CARRY_LEN)
    for (const [query, reply] of TERMINAL_QUERY_REPLIES) {
      for (let at = scan.indexOf(query); at !== -1; at = scan.indexOf(query, at + query.length)) {
        // Why: a query wholly inside the carry was answered on the previous
        // chunk; replying again would land in fish's stdin as typed input.
        if (at + query.length > carriedLength) {
          proc.write(reply)
        }
      }
    }
    if (!commandWritten && output.includes(SHELL_READY_MARKER_OUTPUT)) {
      commandWritten = true
      // Why: mirror PostReadyFlushGate — flush shortly after the post-marker prompt draw.
      setTimeout(() => proc.write(`touch ${sentinel}\n`), 50)
    }
  })
  await done
  clearTimeout(deadline)
  clearInterval(sentinelPoll)
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  proc.kill()
  await exited
  proc.destroy()
  scannedOutput += drainShellStartupOutputScanState(startupScanState)

  return { output, scannedOutput }
}
