import { withGitSpan } from '../../observability/instrumentation'
import {
  resolveGitFetchHeadCommand,
  runWithGitFetchHeadLock
} from '../../../shared/git/fetch/git-fetch-head-lock'
import {
  assertPreparedGitCommand,
  captureGitExecutionContext,
  gitResultWithExecutionContext,
  type GitExecutionContext,
  pendingWslGitPathPreparation
} from './host-routing/wsl-git-path-preparation'
import type { ResolvedCommand } from './host-routing/wsl-command-resolution'
import { annotateWslHostFailure, isTransientWslFailure } from './host-routing/wsl-host-failure'
import { retryGitFetchRefRace } from '../../../shared/git/fetch/git-fetch-ref-race'
import type { GitExecOptions } from './git-exec-options'
import { execFileCapture, execFileCaptureToTermination } from './process-capture/exec-file-capture'
import {
  pendingWslDirectGitReadEnvironment,
  directWslGitExitCode,
  isQuietGitControlFlowExit,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand
} from './host-routing/git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './host-routing/windows-host-git-environment'
import { buildNetworkSshPolicyEnv } from './git-environment/git-ssh-policy-env'
import { nonInteractiveGitEnv } from './git-environment/git-process-env'
import { acquireGitAdmission, releaseGitAdmissionAfter } from './admission/git-subprocess-admission'
import {
  GitCommandTimeoutError,
  gitCommandTimeoutMs
} from '../../../shared/git/commands/git-command-timeout'
import { classifyGitCommand } from '../../../shared/git/commands/git-command-classification'
import { readCapturedGitString } from './process-capture/captured-git-output'
import { runUnlessGitCwdKnownMissing } from './host-routing/missing-git-spawn-cwd'
import { trackGitWorktreeMutation } from './git-worktree-mutation-state'
import { trackGitRefMutation } from './git-ref-mutation-state'
import { routeLocalGitOptions, runAdmittedWslGit } from './host-routing/local-git-runtime-route'
import { gitRunsIn } from './host-routing/git-runs-in'

type GitTextResult = { stdout: string; stderr: string; executionContext?: GitExecutionContext }

async function gitExecFileAsyncUnlocked(
  args: string[],
  options: GitExecOptions,
  terminationState: { current: Promise<void> | null }
): Promise<GitTextResult> {
  // Trace caller intent rather than the resolved binary so WSL and native commands group together.
  return withGitSpan(
    { args, cwd: options.cwd, admissionTier: options.admissionTier },
    async (span) => {
      if (options.onStderr && options.terminationBarrier) {
        throw new Error('onStderr is not supported with terminationBarrier.')
      }
      const checkoutRoutingReady = pendingWslGitPathPreparation(args, options)
      options = {
        ...options,
        executionContext: checkoutRoutingReady
          ? await checkoutRoutingReady
          : captureGitExecutionContext(options)
      }
      const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, options)
      if (readEnvironmentReady) {
        await readEnvironmentReady
      }
      // Buffered reads always fence login rc output; only streaming (gitStreamStdout) must stay unfenced.
      let resolved = resolveGitCommand(args, options, false, true)
      const environmentReady = prepareWindowsHostGitEnvironment(
        resolved,
        options.env,
        options.signal
      )
      const env = environmentReady ? await environmentReady : options.env
      const effectiveOptions = env === options.env ? options : { ...options, env }
      resolved = resolveGitCommand(args, effectiveOptions, false, true)
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
            admissionClass: options.admissionClass,
            signal: options.admissionSignal ?? options.signal
          })
      span?.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
      // Which Git ran: a project's runtime can route it into a distro whatever its cwd.
      span?.setAttribute('git.runs_in', gitRunsIn(resolved))
      const timeoutMs = gitCommandTimeoutMs(args, options.timeout, options.timeoutMsForTest)
      const capture = (
        command: ResolvedCommand
      ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> => {
        assertPreparedGitCommand(command, args, effectiveOptions)
        let reportTerminated: () => void = () => {}
        terminationState.current = new Promise<void>((resolve) => {
          reportTerminated = resolve
        })
        options.observeChildTermination?.(
          terminationState.current,
          classifyGitCommand(args) !== 'read'
        )
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
          spawnOnWorkerThread: options.spawnOnWorkerThread,
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
        // Add a cause when a dead WSL distro returns empty stderr.
        return captured.catch((error: unknown) => {
          throw withCapturedErrorStdout(annotateWslHostFailure(error, command), command)
        })
      }
      const runCapturedCommand = async (): Promise<GitTextResult> => {
        let result: { stdout: string | Buffer; stderr: string | Buffer }
        try {
          result = await capture(resolved)
        } catch (error) {
          if (
            directWslGitExitCode(error, resolved) !== null &&
            // A WSL service failure says nothing about the direct git environment.
            !isTransientWslFailure(error) &&
            !isQuietGitControlFlowExit(error) &&
            !options.signal?.aborted
          ) {
            await terminationState.current
            const wasMissing = invalidateMissingDirectWslGit(error, resolved)
            if (options.canStart?.() === false) {
              throw createAbortError()
            }
            const fallback = resolveGitCommand(args, effectiveOptions, true, true)
            result = await capture(fallback)
            // Why: matching failures can be normal Git control flow; only a successful login retry proves the direct environment was insufficient.
            disableDirectWslGitAfterSuccessfulFallback(wasMissing, resolved)
            const { stdout, stderr } = result
            return gitResultWithExecutionContext(
              {
                stdout: readCapturedGitString(stdout as string, fallback),
                stderr: stderr as string
              },
              fallback.executionContext
            )
          }
          if (options.useConfiguredSshCommandForNetwork && error && typeof error === 'object') {
            Object.assign(error, { gitSshPolicyMode: policy.mode })
          }
          throw error
        }
        const { stdout, stderr } = result
        return gitResultWithExecutionContext(
          {
            stdout: readCapturedGitString(stdout as string, resolved),
            stderr: stderr as string
          },
          resolved.executionContext
        )
      }
      try {
        return await runCapturedCommand()
      } catch (error) {
        return await retryGitFetchRefRace(
          args,
          error,
          runCapturedCommand,
          () => terminationState.current,
          options.signal,
          options.canStart
        )
      } finally {
        releaseGitAdmissionAfter(terminationState.current, grant)
      }
    }
  )
}

/** Callers parse stdout of non-zero exits (check-ignore exit 1), so strip the fence there too. */
function withCapturedErrorStdout(error: unknown, command: ResolvedCommand): unknown {
  if (command.captured && error && typeof error === 'object' && 'stdout' in error) {
    if (typeof error.stdout === 'string') {
      error.stdout = readCapturedGitString(error.stdout, command)
    }
  }
  return error
}

export function gitExecFileAsync(
  args: string[],
  callerOptions: GitExecOptions
): Promise<GitTextResult> {
  const options = routeLocalGitOptions(callerOptions)
  const releaseMutation = trackGitWorktreeMutation(args, options)
  const releaseRefMutation = trackGitRefMutation(args)
  const terminationState: { current: Promise<void> | null } = { current: null }
  const command = resolveGitFetchHeadCommand(args, options.cwd)
  // Missing folders start no child and must not record a git.exec span.
  const result = runAdmittedWslGit(options, () =>
    runUnlessGitCwdKnownMissing(options, () =>
      command.needsLock
        ? runWithGitFetchHeadLock(
            command.cwd,
            options.signal,
            () => gitExecFileAsyncUnlocked(args, options, terminationState),
            command.gitDir
          )
        : gitExecFileAsyncUnlocked(args, options, terminationState)
    )
  )
  return result.finally(() => {
    // A timed-out caller can settle before its child exits.
    if (terminationState.current) {
      void terminationState.current.then(releaseMutation)
      void terminationState.current.then(releaseRefMutation)
    } else {
      releaseMutation()
      releaseRefMutation()
    }
  })
}

export { gitExecFileAsyncBuffer } from './git-exec-file-buffer'
