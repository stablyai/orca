import { execFileSync, type SpawnOptions } from 'node:child_process'
import { withGitSpan } from '../../observability/instrumentation'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import {
  resolveGitFetchHeadCommand,
  runWithGitFetchHeadLock
} from '../../../shared/git-fetch-head-lock'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from '../wsl-linked-worktree-git-routing'
import { resolveCommand, type ResolvedCommand } from './wsl-command-resolution'
import type { GitExecOptions } from './git-exec-options'
import { execFileCapture, execFileCaptureToTermination } from './exec-file-capture'
import {
  pendingWslDirectGitReadEnvironment,
  directWslGitExitCode,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand
} from './git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'
import { buildNetworkSshPolicyEnv } from './git-ssh-policy-env'
import { nonInteractiveGitEnv, untranslatedGitOutputEnv } from './git-process-env'

/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
async function gitExecFileAsyncUnlocked(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  // Why: span the user-visible `git <subcommand>` form, not the resolved binary, so dashboards group by intent.
  return withGitSpan(
    { args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
    async () => {
      if (isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)) {
        await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro, {
          signal: options.signal
        })
      }
      const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, options)
      if (readEnvironmentReady) {
        await readEnvironmentReady
      }
      let resolved = resolveGitCommand(args, options, false, options.captureWslLoginShellOutput)
      const environmentReady = prepareWindowsHostGitEnvironment(
        resolved,
        options.env,
        options.signal
      )
      const env = environmentReady ? await environmentReady : options.env
      const effectiveOptions = env === options.env ? options : { ...options, env }
      resolved = resolveGitCommand(
        args,
        effectiveOptions,
        false,
        effectiveOptions.captureWslLoginShellOutput
      )
      const policy = effectiveOptions.useConfiguredSshCommandForNetwork
        ? await buildNetworkSshPolicyEnv(effectiveOptions)
        : { env: nonInteractiveGitEnv(effectiveOptions.env), mode: 'default' as const }
      const capture = (
        command: ResolvedCommand
      ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> => {
        const captureOptions = {
          cwd: command.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          timeout: options.timeout,
          stdin: options.stdin,
          env: policy.env,
          signal: options.signal,
          terminationBarrier: options.terminationBarrier
        }
        return options.terminationBarrier
          ? execFileCaptureToTermination(
              command.binary,
              command.args,
              captureOptions,
              command.termination
            )
          : execFileCapture(command.binary, command.args, captureOptions)
      }
      let result: { stdout: string | Buffer; stderr: string | Buffer }
      try {
        result = await capture(resolved)
      } catch (error) {
        if (directWslGitExitCode(error, resolved) !== null && !options.signal?.aborted) {
          const wasMissing = invalidateMissingDirectWslGit(error, resolved)
          const fallback = resolveGitCommand(
            args,
            effectiveOptions,
            true,
            effectiveOptions.captureWslLoginShellOutput
          )
          result = await capture(fallback)
          // Why: matching failures can be normal Git control flow; only a successful login retry proves the direct environment was insufficient.
          disableDirectWslGitAfterSuccessfulFallback(wasMissing, resolved)
          const { stdout, stderr } = result
          return {
            stdout: readCapturedGitString(stdout as string, fallback),
            stderr: stderr as string
          }
        }
        if (options.useConfiguredSshCommandForNetwork && error && typeof error === 'object') {
          Object.assign(error, { gitSshPolicyMode: policy.mode })
        }
        throw error
      }
      const { stdout, stderr } = result
      return { stdout: readCapturedGitString(stdout as string, resolved), stderr: stderr as string }
    }
  )
}

export function gitExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const run = () => gitExecFileAsyncUnlocked(args, options)
  const command = resolveGitFetchHeadCommand(args, options.cwd)
  return command.needsLock
    ? runWithGitFetchHeadLock(command.cwd, options.signal, run, command.gitDir)
    : run()
}

/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
export async function gitExecFileAsyncBuffer(
  args: string[],
  options: { cwd: string; maxBuffer?: number; wslDistro?: string; preferWslDirectGit?: boolean }
): Promise<{ stdout: Buffer }> {
  if (isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)) {
    await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro)
  }
  const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, options)
  if (readEnvironmentReady) {
    await readEnvironmentReady
  }
  // `git show` is a read, so this normally runs with no shell at all. The fence
  // still matters for the login-shell fallback: these are raw blob bytes going
  // straight to the diff/blob viewer, where a banner becomes file content.
  let resolved = resolveGitCommand(args, options, false, true)
  const environmentReady = prepareWindowsHostGitEnvironment(resolved, undefined)
  if (environmentReady) {
    await environmentReady
  }
  resolved = resolveGitCommand(args, options, false, true)
  const { stdout } = (await execFileCapture(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: 'buffer',
    maxBuffer: options.maxBuffer,
    env: untranslatedGitOutputEnv()
  })) as { stdout: Buffer }
  return { stdout: readCapturedGitBuffer(stdout, resolved) }
}

/**
 * Slice a fenced payload out of raw bytes.
 *
 * Why bytes: blob content may be binary, so decoding to a string to find the
 * fence would corrupt it. Returns the buffer untouched when the command was not
 * fenced or the fence is absent.
 */
function readCapturedGitBuffer(stdout: Buffer, resolved: ResolvedCommand): Buffer {
  const captured = resolved.captured
  if (!captured) {
    return stdout
  }
  const beginIndex = stdout.lastIndexOf(captured.beginMarker, undefined, 'utf8')
  if (beginIndex === -1) {
    return stdout
  }
  const payloadStart = beginIndex + Buffer.byteLength(captured.beginMarker, 'utf8')
  const endIndex = stdout.indexOf(captured.endMarker, payloadStart, 'utf8')
  return endIndex === -1 ? stdout.subarray(payloadStart) : stdout.subarray(payloadStart, endIndex)
}

function readCapturedGitString(stdout: string, resolved: ResolvedCommand): string {
  const captured = resolved.captured
  if (!captured) {
    return stdout
  }
  const beginIndex = stdout.lastIndexOf(captured.beginMarker)
  if (beginIndex === -1) {
    return stdout
  }
  const payloadStart = beginIndex + captured.beginMarker.length
  const endIndex = stdout.indexOf(captured.endMarker, payloadStart)
  return endIndex === -1 ? stdout.slice(payloadStart) : stdout.slice(payloadStart, endIndex)
}

// Why: sync git blocks the main thread; a dead network drive can hang git for minutes without a timeout (issue #7225's 127s freeze).
const GIT_EXEC_SYNC_TIMEOUT_MS = 15_000

/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
    timeout?: number
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  const spawnStartedAt = performance.now()
  try {
    return execFileSync(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      env: untranslatedGitOutputEnv(),
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? GIT_EXEC_SYNC_TIMEOUT_MS,
      windowsHide: true
    }) as string
  } finally {
    // Sync exec blocks the main thread for its whole duration — the cost issue #7576 flags.
    recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  }
}
