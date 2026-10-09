import { execFile } from 'node:child_process'
import path from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { getSystemCliInstallDirectories } from '../../shared/system-cli-install-dirs'
import { runProcess } from '../../shared/child-process/run-process'
import {
  beginLocalCommandSelection,
  isCommandOnLocalPath,
  listLocalCommandPaths
} from './command-path-resolver'
import { buildLocalPreflightEnv } from './preflight-local-env'
import { runPreflightCommandInWsl } from './preflight-wsl-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)
export const PREFLIGHT_COMMAND_TIMEOUT_MS = 5000
const WSL_COMMAND_PATH_SENTINEL = '__ORCA_PREFLIGHT_COMMAND_PATH__'

export type PreflightCommandResult = { stdout: string; stderr: string }

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function withPreflightTimeout<T>(
  command: string,
  commandPromise: Promise<T>,
  timeoutMs = PREFLIGHT_COMMAND_TIMEOUT_MS
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(new Error(`Timed out running ${command}`), {
            code: 'ETIMEDOUT'
          })
          reject(error)
        }, timeoutMs)
        if (typeof timeout.unref === 'function') {
          timeout.unref()
        }
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

/** Rejects on non-zero exit, spawn failure, or timeout — it never reports
 *  "absent" as a value. A caller that collapses that rejection into `false`
 *  makes "not installed" and "could not run it" the same answer; see
 *  docs/reference/wsl-probe-failure-semantics.md before doing so. */
export async function execLocalPreflightCommandOrThrow(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; terminationBarrier?: boolean } = {}
): Promise<PreflightCommandResult> {
  const env = options.env ?? buildLocalPreflightEnv()
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_COMMAND_TIMEOUT_MS
  // Node cannot execFile a batch shim; the shared runner handles its argv safely.
  if (
    options.terminationBarrier ||
    (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))
  ) {
    const pending = runProcess({
      program: command,
      args,
      env,
      timeoutMs,
      ...(options.terminationBarrier ? { terminationBarrier: true } : {})
    })
    const result = options.terminationBarrier
      ? await pending
      : await withPreflightTimeout(command, pending, timeoutMs)
    if (result.timedOut || result.outputTruncated || result.code !== 0) {
      throw Object.assign(new Error(`Failed running ${command}`), {
        ...result,
        code: result.timedOut ? 'ETIMEDOUT' : result.code
      })
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }
  const commandPromise = execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    // Preflight probes console-subsystem binaries (git, gh, node); without this
    // each one flashes a console and steals foreground on Windows (#10488).
    windowsHide: true,
    ...(env ? { env } : {})
  })

  return withPreflightTimeout(command, commandPromise, timeoutMs)
}

// Throws on any failure — a distro that is booting/unreachable throws the
// same way a command that genuinely doesn't exist does. Callers must not
// collapse both into "absent"; see docs/reference/wsl-probe-failure-semantics.md.
export async function execCommandInWslOrThrow(
  target: WslPreflightTarget,
  command: string
): Promise<PreflightCommandResult> {
  const commandPromise = runPreflightCommandInWsl(target, command, PREFLIGHT_COMMAND_TIMEOUT_MS)
  // Label only (runPreflightCommandInWsl owns the actual wsl.exe invocation) —
  // not the literal 'wsl.exe' so the wsl-invocation-boundary guard doesn't
  // mistake this string for a spawn site.
  return withPreflightTimeout('wsl command', commandPromise)
}

const PREFLIGHT_LOCAL_PROBE_LIMIT = 4

export type LocalCommandProbe =
  | { status: 'available'; binary: string }
  | { status: 'absent' }
  | { status: 'exec_failed' | 'timeout' | 'limit_reached'; binary: string }

function probeTimedOut(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  return (
    ('killed' in error && error.killed === true) || ('code' in error && error.code === 'ETIMEDOUT')
  )
}

async function localProbeCandidates(
  command: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<string[]> {
  const isWin = process.platform === 'win32'
  const probeEnv = env ?? process.env
  // Keep relative PATH entries in their original position, as execFile does.
  const absoluteEnv = isWin
    ? probeEnv
    : {
        ...probeEnv,
        PATH: (probeEnv.PATH ?? '')
          .split(path.delimiter)
          .map((dir) => path.resolve(dir))
          .join(path.delimiter)
      }
  const maxResults = PREFLIGHT_LOCAL_PROBE_LIMIT + 1
  const paths = await listLocalCommandPaths(command, { env: absoluteEnv, maxResults })
  const installPaths =
    isWin || paths.length >= maxResults
      ? []
      : await listLocalCommandPaths(command, {
          env: {
            PATH: getSystemCliInstallDirectories(process.platform, homedir()).join(path.delimiter)
          },
          maxResults
        })
  return [...new Set([...paths, ...installPaths])]
}

/** Try only version probes; authentication must stay on the selected binary. */
export async function findRunnableLocalCommand(command: string): Promise<LocalCommandProbe> {
  const publishSelection = beginLocalCommandSelection(command)
  const result = await probeRunnableLocalCommand(command)
  await publishSelection(result.status === 'available' ? result.binary : null)
  return result
}

async function probeRunnableLocalCommand(command: string): Promise<LocalCommandProbe> {
  const env = buildLocalPreflightEnv()
  const explicit = command.includes('/') || (process.platform === 'win32' && command.includes('\\'))
  // An explicit path is the user's selection, even when it cannot run.
  const candidates = explicit ? [] : await localProbeCandidates(command, env)
  const probes = candidates.length ? candidates.slice(0, PREFLIGHT_LOCAL_PROBE_LIMIT) : [command]
  const deadline = Date.now() + PREFLIGHT_COMMAND_TIMEOUT_MS
  let recoveryDeadline: number | undefined
  let timedOutBinary: string | undefined
  for (const [index, binary] of probes.entries()) {
    const remainingMs = (recoveryDeadline ?? deadline) - Date.now()
    if (remainingMs <= 0) {
      return { status: 'timeout', binary }
    }
    // Healthy CLIs keep their full budget; only timeout recovery divides a second budget.
    const timeoutMs = recoveryDeadline
      ? Math.max(1, Math.floor(remainingMs / (probes.length - index)))
      : remainingMs
    try {
      await execLocalPreflightCommandOrThrow(binary, ['--version'], {
        env,
        timeoutMs,
        ...(probes.length > 1 ? { terminationBarrier: true } : {})
      })
      return { status: 'available', binary }
    } catch (error) {
      if (probeTimedOut(error)) {
        timedOutBinary = binary
        recoveryDeadline ??= Date.now() + PREFLIGHT_COMMAND_TIMEOUT_MS
        continue
      }
      if (
        candidates.length === 0 &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT' &&
        !(await isCommandOnLocalPath(explicit ? path.resolve(command) : command, { env }))
      ) {
        return { status: 'absent' }
      }
    }
  }
  if (timedOutBinary) {
    return { status: 'timeout', binary: timedOutBinary }
  }
  return {
    status: candidates.length > PREFLIGHT_LOCAL_PROBE_LIMIT ? 'limit_reached' : 'exec_failed',
    binary: probes.at(-1) ?? command
  }
}

export async function isCommandAvailable(
  command: string,
  wslTarget?: WslPreflightTarget
): Promise<boolean> {
  if (!wslTarget) {
    return (await findRunnableLocalCommand(command)).status === 'available'
  }
  try {
    await execCommandInWslOrThrow(wslTarget, `${shellQuote(command)} --version`)
    return true
  } catch {
    return false
  }
}

export async function isCommandOnPath(
  command: string,
  wslTarget?: WslPreflightTarget
): Promise<boolean> {
  if (!wslTarget) {
    // Why (#9297): resolve against PATH with fs instead of spawning one
    // where/which subprocess per probe — privilege-management software gates
    // each spawn and stalls startup. buildLocalPreflightEnv() supplies the same
    // registry-merged PATH the child process previously saw (undefined = posix
    // process.env), so the found/not-found result is identical.
    return isCommandOnLocalPath(command, { env: buildLocalPreflightEnv() })
  }
  try {
    // Why: preflight must validate the executable on PATH, not a shell alias or function.
    const { stdout } = await execCommandInWslOrThrow(
      wslTarget,
      [
        // Same skip as agent detection: without it this branch answers "yes"
        // for a Windows binary reached through interop, so preflight and the
        // detector disagree about the same distro.
        buildPosixCommandPathLookupScript(
          { kind: 'literal', value: command },
          { skipWindowsMountDirs: true }
        ),
        'if [ -n "$resolved" ]; then',
        `printf '${WSL_COMMAND_PATH_SENTINEL}%s\\n' "$resolved"`,
        'fi'
      ].join('\n')
    )
    // Why: WSL startup chatter can contain unrelated absolute paths.
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(WSL_COMMAND_PATH_SENTINEL))
      .map((line) => line.slice(WSL_COMMAND_PATH_SENTINEL.length))
      .some((line) => path.posix.isAbsolute(line))
  } catch {
    return false
  }
}
