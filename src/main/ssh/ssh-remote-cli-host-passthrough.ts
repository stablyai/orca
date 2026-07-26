// Why: the SSH relay shim (`~/.orca-relay/bin/orca`) forwards CLI invocations
// to the host app. Instead of re-implementing every command in a hand-rolled
// switch (the cause of "Unsupported SSH Orca CLI command", #7716), the host
// runs the real bundled `orca` CLI entry in Electron node mode — the same
// entry the local shell command uses — so remote invocations get the full
// command surface (orchestration, worktree, terminal, ...) by construction.
import { app } from 'electron'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence'
import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'

export type RemoteOrcaCliRequest = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
}

export type RemoteOrcaCliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type HostCliPassthroughOptions = {
  execPath?: string
  cliEntryPath?: string
  userDataPath?: string
  hostEnv?: NodeJS.ProcessEnv
  spawn?: typeof nodeSpawn
  entryExists?: (path: string) => boolean
  killTimeoutMs?: number
}

/** Thrown when the host CLI entry cannot be launched at all; callers fall back
 * to the legacy in-process command switch so previously-working commands keep
 * working even on broken installs. */
export class HostCliUnavailableError extends Error {}

// Why: only Orca terminal-context vars may cross from the remote shell into
// the host CLI process. Remote PATH / ORCA_USER_DATA_PATH are paths on the
// remote machine (meaningless or instance-hijacking on the host), and
// NODE_OPTIONS-style vars could alter host execution.
const REMOTE_CONTEXT_ENV_VARS = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_WORKTREE_ID',
  'ORCA_PANE_KEY',
  'ORCA_WORKSPACE_ID'
] as const

// Why: bound captured output so a runaway command cannot balloon the relay
// JSON-RPC response or main-process memory.
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_KILL_TIMEOUT_MS = 10 * 60_000
const KILL_TIMEOUT_GRACE_MS = 2 * 60_000

export function resolveHostCliEntryPath(app: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  // Why: mirrors the packaged launcher scripts (resources/*/bin) and the dev
  // launcher in cli-installer.ts — packaged builds ship the CLI entry outside
  // app.asar so Electron node mode can execute it directly.
  return app.isPackaged
    ? join(app.resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
    : join(app.appPath, 'out', 'cli', 'index.js')
}

/** Kill timer for the host CLI subprocess. Long-poll commands carry their wait
 * budget in `--timeout-ms`; extend past it so the CLI's own timeout fires
 * first and produces a proper error message. */
export function resolveHostCliKillTimeoutMs(argv: string[]): number {
  const explicit = parseTimeoutMsFlag(argv)
  if (explicit !== null && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(DEFAULT_KILL_TIMEOUT_MS, explicit + KILL_TIMEOUT_GRACE_MS)
  }
  return DEFAULT_KILL_TIMEOUT_MS
}

export function buildHostCliEnv(args: {
  hostEnv: NodeJS.ProcessEnv
  remoteEnv: Record<string, string>
  userDataPath: string
  remoteCwd: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...args.hostEnv }
  for (const key of REMOTE_CONTEXT_ENV_VARS) {
    const value = args.remoteEnv[key]
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
  // Why: bind the subprocess to this app instance's runtime metadata (dev and
  // parallel instances use non-default userData dirs).
  env.ORCA_USER_DATA_PATH = args.userDataPath
  // Why: the caller's working directory lives on the remote machine, so the
  // subprocess cwd cannot be chdir'd there; ORCA_CLI_CWD carries it for
  // cwd-based selectors like `--worktree active`.
  env.ORCA_CLI_CWD = args.remoteCwd
  // Why: same node-mode hygiene as the shipped CLI launchers — stash and clear
  // NODE_OPTIONS so Electron's node bootstrap does not inherit them.
  env.ORCA_NODE_OPTIONS = args.hostEnv.NODE_OPTIONS ?? ''
  env.ORCA_NODE_REPL_EXTERNAL_MODULE = args.hostEnv.NODE_REPL_EXTERNAL_MODULE ?? ''
  delete env.NODE_OPTIONS
  delete env.NODE_REPL_EXTERNAL_MODULE
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export async function runHostOrcaCliPassthrough(
  request: RemoteOrcaCliRequest,
  options: HostCliPassthroughOptions = {}
): Promise<RemoteOrcaCliResult> {
  // Why: per-field lazy defaults keep the module testable — tests inject all
  // three, so no Electron API is touched outside the production path.
  const execPath = options.execPath ?? process.execPath
  let cliEntryPath: string
  let userDataPath: string
  try {
    cliEntryPath =
      options.cliEntryPath ??
      resolveHostCliEntryPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
    // Why: must match the userData dir the runtime RPC server writes metadata
    // to (see index.ts OrcaRuntimeRpcServer wiring), or the CLI subprocess
    // reports "Orca is not running" against a healthy app.
    userDataPath = options.userDataPath ?? getCanonicalUserDataPath()
  } catch (err) {
    // Why: no Electron app context (or broken install paths) — degrade to the
    // caller's legacy in-process fallback instead of failing the command.
    throw new HostCliUnavailableError(
      `Host CLI environment unavailable: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const hostEnv = options.hostEnv ?? process.env
  const spawn = options.spawn ?? nodeSpawn
  const entryExists = options.entryExists ?? existsSync
  const killTimeoutMs = options.killTimeoutMs ?? resolveHostCliKillTimeoutMs(request.argv)

  if (!entryExists(cliEntryPath)) {
    throw new HostCliUnavailableError(`Orca CLI entry not found at ${cliEntryPath}`)
  }

  const env = buildHostCliEnv({
    hostEnv,
    remoteEnv: request.env,
    userDataPath,
    remoteCwd: request.cwd
  })

  return await new Promise<RemoteOrcaCliResult>((resolve, reject) => {
    let settled = false
    const child = spawn(execPath, [cliEntryPath, ...request.argv], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    const stdout = new CappedOutputCollector(MAX_CAPTURED_OUTPUT_BYTES)
    const stderr = new CappedOutputCollector(MAX_CAPTURED_OUTPUT_BYTES)

    const killTimer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // best effort — process may already be gone
      }
      resolve({
        stdout: stdout.toString(),
        stderr: `${stderr.toString()}Orca CLI bridge timed out after ${killTimeoutMs}ms on the host.\n`,
        exitCode: 1
      })
    }, killTimeoutMs)
    killTimer.unref?.()

    child.on('error', (err) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(killTimer)
      // Why: failure to launch (ENOENT, EACCES) means the host CLI is not
      // runnable at all — signal the caller to use the legacy fallback rather
      // than reporting a confusing per-command failure.
      reject(
        new HostCliUnavailableError(`Failed to launch the Orca CLI on the host: ${err.message}`)
      )
    })

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(killTimer)
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: typeof code === 'number' ? code : 1
      })
    })

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Why: the CLI may exit without draining stdin; EPIPE here is routine.
      })
      if (request.stdin !== undefined) {
        child.stdin.end(request.stdin)
      } else {
        child.stdin.end()
      }
    }
  })
}

class CappedOutputCollector {
  private readonly output = new GrowingByteBuffer()
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) {
      return
    }
    const remaining = this.maxBytes - this.output.byteLength
    if (chunk.length >= remaining) {
      this.output.append(chunk.subarray(0, remaining))
      this.truncated = true
      return
    }
    this.output.append(chunk)
  }

  toString(): string {
    const text = this.output.toString()
    return this.truncated ? `${text}\n[orca ssh cli] output truncated\n` : text
  }
}

function parseTimeoutMsFlag(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--timeout-ms') {
      const next = argv[i + 1]
      const parsed = next === undefined ? Number.NaN : Number(next)
      return Number.isFinite(parsed) ? parsed : null
    }
    if (token.startsWith('--timeout-ms=')) {
      const parsed = Number(token.slice('--timeout-ms='.length))
      return Number.isFinite(parsed) ? parsed : null
    }
  }
  return null
}
