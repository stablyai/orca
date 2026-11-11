import { spawn, type ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  LOCAL_COMMAND_OUTPUT_CAP_BYTES,
  type LocalCommandRunResult
} from '../../shared/local-commands/local-command-contract'

const KILL_GRACE_MS = 3_000
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/** Names copied from this app's own environment; nothing else is passed (no tokens, keys, sockets). */
const PASSTHROUGH = ['USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const

export function localCommandsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** The folder a command runs in: ~ expanded, symlinks resolved, must be a directory. Null if not. */
export async function resolveLocalCommandCwd(
  requested: string | null,
  home: string = homedir()
): Promise<string | null> {
  const raw =
    requested === null || requested === '~'
      ? home
      : requested.startsWith('~/')
        ? join(home, requested.slice(2))
        : requested
  if (!isAbsolute(raw)) {
    return null
  }
  try {
    const resolved = await realpath(raw)
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

/**
 * A minimal environment: the login shell's PATH (so Homebrew and Xcode tools resolve), the home
 * folder and locale. Orca's own environment and the shell profile's exports are never passed, so
 * API keys, tokens and agent sockets don't reach the command.
 */
export function buildLocalCommandEnv(
  shellPath: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: shellPath?.trim() || FALLBACK_PATH,
    HOME: home,
    SHELL: '/bin/sh',
    TERM: 'dumb',
    ORCA_LOCAL_COMMAND: '1'
  }
  for (const name of PASSTHROUGH) {
    const value = source[name]
    if (typeof value === 'string' && value) {
      env[name] = value
    }
  }
  return env
}

class CappedOutput {
  private readonly chunks: Buffer[] = []
  bytes = 0
  kept = 0
  truncated = false

  push(chunk: Buffer): void {
    this.bytes += chunk.length
    const room = LOCAL_COMMAND_OUTPUT_CAP_BYTES - this.kept
    if (room <= 0) {
      this.truncated = true
      return
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (slice.length < chunk.length) {
      this.truncated = true
    }
    this.chunks.push(slice)
    this.kept += slice.length
  }

  text(): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(this.chunks))
  }
}

const running = new Set<ChildProcess>()

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return
  }
  try {
    // Negative pid: the whole process group, so `sh -c 'a | b'` and backgrounded children stop too.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

/** Stops every command still running (app quit). Their workspaces see the result as lost. */
export function stopAllLocalCommands(): void {
  for (const child of running) {
    killGroup(child, 'SIGKILL')
  }
  running.clear()
}

export type LocalCommandExecution = {
  command: string
  cwd: string
  timeoutSec: number
  env: Record<string, string>
}

export type LocalCommandExecutionOutcome = LocalCommandRunResult & {
  stdoutBytes: number
  stderrBytes: number
}

/** Runs exactly `command` with /bin/sh -c: no stdin, its own process group, a hard timeout. */
export function executeLocalCommand(
  input: LocalCommandExecution
): Promise<LocalCommandExecutionOutcome> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const stdout = new CappedOutput()
    const stderr = new CappedOutput()
    let timedOut = false
    let child: ChildProcess
    try {
      child = spawn('/bin/sh', ['-c', input.command], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true
      })
    } catch (error) {
      reject(error)
      return
    }
    running.add(child)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const timeout = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS)
    }, input.timeoutSec * 1000)
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      running.delete(child)
      // A command that exited may have left children in its group; they don't outlive the request.
      killGroup(child, 'SIGKILL')
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes
      })
    }
    child.once('error', (error) => {
      clearTimeout(timeout)
      running.delete(child)
      reject(error)
    })
    child.once('close', finish)
  })
}
