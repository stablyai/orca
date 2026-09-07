// The SSH shim runs the bundled CLI so remote shells get the full command surface.
import { app } from 'electron'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getCanonicalUserDataPath } from '../persistence'
import { resolveHostCliKillTimeoutMs } from './ssh-host-cli-deadline'
export { resolveHostCliKillTimeoutMs } from './ssh-host-cli-deadline'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../../shared/timer-delay'
import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV
} from '../../shared/orchestration-compatibility-evidence'
import {
  REMOTE_ARTIFACT_INPUT_ENV,
  sshArtifactSourceKey,
  type RemoteArtifactInput
} from '../../shared/artifact-cli-bridge'

export type SshCliRuntimeAuthority = {
  kind: 'ssh'
  targetId: string
  connectionIncarnation: string
  attachmentId: string
}

export type RemoteOrcaCliRequest = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
  artifactInput?: RemoteArtifactInput
  runtimeAuthority?: SshCliRuntimeAuthority
}

export type RemoteOrcaCliResult = {
  stdout: string
  stderr: string
  exitCode: number
  postOutput?: RemoteOrcaCliPostOutput
}

export type RemoteOrcaCliPostOutput =
  | {
      kind: 'legacy_check_ack'
      terminal: string
      messageIds: string[]
      types?: string[]
    }
  | {
      kind: 'legacy_question_ack'
      terminal: string
      questionId: string
      answerMessageId: string
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

// Only terminal identity may cross hosts; remote paths and Node options cannot.
const REMOTE_CONTEXT_ENV_VARS = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_WORKTREE_ID',
  'ORCA_PANE_KEY',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_WORKSPACE_ID'
] as const

// Bound output retained for the relay response.
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024

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

export function buildHostCliEnv(args: {
  hostEnv: NodeJS.ProcessEnv
  remoteEnv: Record<string, string>
  userDataPath: string
  remoteCwd: string
  runtimeAuthority?: SshCliRuntimeAuthority
  artifactInput?: RemoteArtifactInput
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
  // Why: recovery commands run on the SSH execution host through its relay shim.
  env.ORCA_CLI_COMMAND = 'orca'
  // Why: same node-mode hygiene as the shipped CLI launchers — stash and clear
  // NODE_OPTIONS so Electron's node bootstrap does not inherit them.
  env.ORCA_NODE_OPTIONS = args.hostEnv.NODE_OPTIONS ?? ''
  env.ORCA_NODE_REPL_EXTERNAL_MODULE = args.hostEnv.NODE_REPL_EXTERNAL_MODULE ?? ''
  delete env.NODE_OPTIONS
  delete env.NODE_REPL_EXTERNAL_MODULE
  delete env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]
  delete env[ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]
  delete env[ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]
  delete env[ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV]
  delete env[REMOTE_ARTIFACT_INPUT_ENV]
  if (args.runtimeAuthority) {
    env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV] = 'ssh'
    env[ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV] = args.runtimeAuthority.targetId
    env[ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV] =
      args.runtimeAuthority.connectionIncarnation
    env[ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV] = args.runtimeAuthority.attachmentId
  }
  if (args.artifactInput) {
    const sourceKey = args.runtimeAuthority
      ? sshArtifactSourceKey(args.runtimeAuthority.targetId, args.artifactInput.sourceKey)
      : args.artifactInput.sourceKey
    env[REMOTE_ARTIFACT_INPUT_ENV] = JSON.stringify({ ...args.artifactInput, sourceKey })
  }
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
  if (!isSafeTimerDelayMs(killTimeoutMs)) {
    throw new RangeError(
      `Host CLI kill timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }

  if (!entryExists(cliEntryPath)) {
    throw new HostCliUnavailableError(`Orca CLI entry not found at ${cliEntryPath}`)
  }

  const env = buildHostCliEnv({
    hostEnv,
    remoteEnv: request.env,
    userDataPath,
    remoteCwd: request.cwd,
    runtimeAuthority: request.runtimeAuthority,
    artifactInput: request.artifactInput
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
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) {
      return
    }
    const remaining = this.maxBytes - this.bytes
    if (chunk.length >= remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.bytes = this.maxBytes
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    return this.truncated ? `${text}\n[orca ssh cli] output truncated\n` : text
  }
}
