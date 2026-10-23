import { execFileSync, type SpawnOptions } from 'node:child_process'
import { withGitSpan } from '../../observability/instrumentation'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import {
  resolveGitFetchHeadCommand,
  runWithGitFetchHeadLock
} from '../../../shared/git-fetch-head-lock'
import { pendingWslDriveCheckoutGitRouting } from '../wsl-drive-checkout-git-routing'
import { resolveCommand, type ResolvedCommand } from './wsl-command-resolution'
import { annotateWslHostFailure } from './wsl-host-failure'
import type { GitAdmissionTier, GitExecOptions } from './git-exec-options'
import { execFileCapture, execFileCaptureToTermination } from './exec-file-capture'
import {
  pendingWslDirectGitReadEnvironment,
  directWslGitExitCode,
  isQuietGitControlFlowExit,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand
} from './git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'
import { buildNetworkSshPolicyEnv } from './git-ssh-policy-env'
import { nonInteractiveGitEnv, untranslatedGitOutputEnv } from './git-process-env'
import { acquireGitAdmission } from './git-subprocess-admission'
import { GitCommandTimeoutError, gitCommandTimeoutMs } from './git-command-timeout'
import { classifyGitCommand } from '../../../shared/git-command-classification'
import { createAbortError } from './abort-error'
import { readCapturedGitBuffer, readCapturedGitString } from './captured-git-output'
import { runUnlessGitCwdKnownMissing } from './missing-git-spawn-cwd'
import { trackGitWorktreeMutation } from '../git-worktree-mutation-state'

/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
async function gitExecFileAsyncUnlocked(
  args: string[],
  options: GitExecOptions,
  terminationState: { current: Promise<void> | null }
): Promise<{ stdout: string; stderr: string }> {
  // Why: span the user-visible `git <subcommand>` form, not the resolved binary, so dashboards group by intent.
  return withGitSpan(
    { args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
    async (span) => {
      if (options.onStderr && options.terminationBarrier) {
        // Why: checked before admission; that path's streams belong to runProcess.
        throw new Error('onStderr is not supported with terminationBarrier.')
      }
      const checkoutRoutingReady = pendingWslDriveCheckoutGitRouting(args, options)
      if (checkoutRoutingReady) {
        await checkoutRoutingReady
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
      const policy =
        effectiveOptions.useConfiguredSshCommandForNetwork || classifyGitCommand(args) === 'network'
          ? await buildNetworkSshPolicyEnv(effectiveOptions, args)
          : { env: nonInteractiveGitEnv(effectiveOptions.env), mode: 'default' as const }
      const grant = options.admissionExempt
        ? { queueWaitMs: 0, release: () => {} }
        : await acquireGitAdmission({
            args,
            cwd: options.cwd,
            wslDistro: options.wslDistro,
            tier: options.admissionTier,
            signal: options.admissionSignal ?? options.signal
          })
      span?.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
      const timeoutMs = gitCommandTimeoutMs(args, options.timeout, options.timeoutMsForTest)
      const capture = (
        command: ResolvedCommand
      ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> => {
        let reportTerminated: () => void = () => {}
        terminationState.current = new Promise<void>((resolve) => {
          reportTerminated = resolve
        })
        const captureOptions = {
          cwd: command.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          timeout: timeoutMs,
          stdin: options.stdin,
          env: policy.env,
          signal: options.signal,
          terminationBarrier: options.terminationBarrier,
          admissionTier: options.admissionTier,
          onChildTerminated: reportTerminated,
          ...(options.onStderr ? { onStderr: options.onStderr } : {}),
          ...(timeoutMs === undefined
            ? {}
            : { createTimeoutError: () => new GitCommandTimeoutError(timeoutMs) })
        }
        const captured = options.terminationBarrier
          ? execFileCaptureToTermination(
              command.binary,
              command.args,
              captureOptions,
              command.termination
            )
          : execFileCapture(command.binary, command.args, captureOptions)
        // Why: a dead WSL distro fails with an empty stderr, so the span would carry no cause at all.
        return captured.catch((error: unknown) => {
          throw annotateWslHostFailure(error, command)
        })
      }
      const runCapturedCommand = async (): Promise<{ stdout: string; stderr: string }> => {
        let result: { stdout: string | Buffer; stderr: string | Buffer }
        try {
          result = await capture(resolved)
        } catch (error) {
          if (
            directWslGitExitCode(error, resolved) !== null &&
            !isQuietGitControlFlowExit(error) &&
            !options.signal?.aborted
          ) {
            await terminationState.current
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
        return {
          stdout: readCapturedGitString(stdout as string, resolved),
          stderr: stderr as string
        }
      }
      try {
        options.admissionSignal?.throwIfAborted()
        if (options.canStart?.() === false) {
          throw createAbortError()
        }
        return await runCapturedCommand()
      } finally {
        const termination = terminationState.current
        if (termination) {
          void termination.then(grant.release)
        } else {
          grant.release()
        }
      }
    }
  )
}

export function gitExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const releaseMutation = trackGitWorktreeMutation(args, options)
  const terminationState: { current: Promise<void> | null } = { current: null }
  const command = resolveGitFetchHeadCommand(args, options.cwd)
  // Why outside the lock and span: a known-missing folder starts no process, so it records no git.exec.
  const result = runUnlessGitCwdKnownMissing(options, () =>
    command.needsLock
      ? runWithGitFetchHeadLock(
          command.cwd,
          options.signal,
          () => gitExecFileAsyncUnlocked(args, options, terminationState),
          command.gitDir
        )
      : gitExecFileAsyncUnlocked(args, options, terminationState)
  )
  return result.finally(() => {
    // A timed-out caller can settle before its child exits.
    if (terminationState.current) {
      void terminationState.current.then(releaseMutation)
    } else {
      releaseMutation()
    }
  })
}

/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
async function gitExecFileAsyncBufferInSpan(
  args: string[],
  options: {
    cwd: string
    maxBuffer?: number
    timeout?: number
    timeoutMsForTest?: number
    env?: NodeJS.ProcessEnv
    wslDistro?: string
    preferWslDirectGit?: boolean
    admissionTier?: GitAdmissionTier
    signal?: AbortSignal
    stdin?: string
  }
): Promise<{ stdout: Buffer }> {
  return withGitSpan({ args, cwd: options.cwd }, async (span) => {
    const checkoutRoutingReady = pendingWslDriveCheckoutGitRouting(args, options)
    if (checkoutRoutingReady) {
      await checkoutRoutingReady
    }
    const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, options)
    if (readEnvironmentReady) {
      await readEnvironmentReady
    }
    // `git show` is a read, so this normally runs with no shell at all. The fence
    // still matters for the login-shell fallback: these are raw blob bytes going
    // straight to the diff/blob viewer, where a banner becomes file content.
    let resolved = resolveGitCommand(args, options, false, true)
    const environmentReady = prepareWindowsHostGitEnvironment(resolved, undefined, options.signal)
    if (environmentReady) {
      await environmentReady
    }
    resolved = resolveGitCommand(args, options, false, true)
    const grant = await acquireGitAdmission({
      args,
      cwd: options.cwd,
      wslDistro: options.wslDistro,
      tier: options.admissionTier,
      signal: options.signal
    })
    span?.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
    const timeoutMs = gitCommandTimeoutMs(args, options.timeout, options.timeoutMsForTest)
    let termination: Promise<void> | null = null
    try {
      let reportTerminated: () => void = () => {}
      termination = new Promise<void>((resolve) => {
        reportTerminated = resolve
      })
      const { stdout } = await execFileCapture(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: 'buffer',
        signal: options.signal,
        stdin: options.stdin,
        maxBuffer: options.maxBuffer,
        timeout: timeoutMs,
        env: untranslatedGitOutputEnv(options.env),
        admissionTier: options.admissionTier,
        onChildTerminated: reportTerminated,
        ...(timeoutMs === undefined
          ? {}
          : { createTimeoutError: () => new GitCommandTimeoutError(timeoutMs) })
      })
      if (!Buffer.isBuffer(stdout)) {
        throw new Error('Git buffer capture returned text instead of bytes')
      }
      return { stdout: readCapturedGitBuffer(stdout, resolved) }
    } finally {
      if (termination) {
        void termination.then(grant.release)
      } else {
        grant.release()
      }
    }
  })
}

// Why: sync git blocks the main thread; a dead network drive can hang git for minutes without a timeout (issue #7225's 127s freeze).
const GIT_EXEC_SYNC_TIMEOUT_MS = 15_000

export function gitExecFileAsyncBuffer(
  args: string[],
  options: Parameters<typeof gitExecFileAsyncBufferInSpan>[1]
): Promise<{ stdout: Buffer }> {
  return runUnlessGitCwdKnownMissing(options, () => gitExecFileAsyncBufferInSpan(args, options))
}

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
