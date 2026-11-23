import { withGitSpan } from '../../observability/instrumentation'
import type { GitBufferExecOptions } from './git-exec-options'
import { execFileCapture, execFileCaptureToTermination } from './process-capture/exec-file-capture'
import {
  pendingWslDirectGitReadEnvironment,
  resolveGitCommand
} from './host-routing/git-command-resolution'
import { pendingWslDriveCheckoutGitRouting } from './host-routing/wsl-drive-checkout-git-routing'
import { prepareWindowsHostGitEnvironment } from './host-routing/windows-host-git-environment'
import { acquireGitAdmission, releaseGitAdmissionAfter } from './admission/git-subprocess-admission'
import { gitRunsIn } from './host-routing/git-runs-in'
import {
  GitCommandTimeoutError,
  gitCommandTimeoutMs
} from '../../../shared/git/commands/git-command-timeout'
import { untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { readCapturedGitBuffer } from './process-capture/captured-git-output'
import { runUnlessGitCwdKnownMissing } from './host-routing/missing-git-spawn-cwd'
import { routeLocalGitOptions, runAdmittedWslGit } from './host-routing/local-git-runtime-route'

async function gitExecFileAsyncBufferInSpan(
  args: string[],
  options: GitBufferExecOptions
): Promise<{ stdout: Buffer }> {
  const meta = { args, cwd: options.cwd, admissionTier: options.admissionTier }
  return withGitSpan(meta, async (span) => {
    const checkoutRoutingReady = pendingWslDriveCheckoutGitRouting(args, options)
    if (checkoutRoutingReady) {
      await checkoutRoutingReady
    }
    const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, options)
    if (readEnvironmentReady) {
      await readEnvironmentReady
    }
    // Fence fallback login-shell output so rc banners cannot become raw blob content.
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
    span?.setAttribute('git.runs_in', gitRunsIn(resolved))
    const timeoutMs = gitCommandTimeoutMs(args, options.timeout, options.timeoutMsForTest)
    let termination: Promise<void> | null = null
    try {
      let reportTerminated: () => void = () => {}
      termination = new Promise<void>((resolve) => {
        reportTerminated = resolve
      })
      const captureOptions = {
        cwd: resolved.cwd,
        ownedPosixGroup: process.platform !== 'win32' && !resolved.wsl,
        encoding: 'buffer' as const,
        signal: options.signal,
        stdin: options.stdin,
        maxBuffer: options.maxBuffer,
        timeout: timeoutMs,
        env: untranslatedGitOutputEnv(options.env),
        admissionTier: options.admissionTier,
        onChildTerminated: reportTerminated,
        // A buffered read holds only admission, so a lost worker ends it.
        workerLossEndsLifetime: true,
        ...(timeoutMs === undefined
          ? {}
          : { createTimeoutError: () => new GitCommandTimeoutError(timeoutMs) })
      }
      const { stdout } = await (options.terminationBarrier
        ? execFileCaptureToTermination(
            resolved.binary,
            resolved.args,
            captureOptions,
            resolved.termination
          )
        : execFileCapture(resolved.binary, resolved.args, captureOptions))
      if (!Buffer.isBuffer(stdout)) {
        throw new Error('Git buffer capture returned text instead of bytes')
      }
      return { stdout: readCapturedGitBuffer(stdout, resolved) }
    } finally {
      releaseGitAdmissionAfter(termination, grant)
      if (options.terminationBarrier) {
        await termination
      }
    }
  })
}

export function gitExecFileAsyncBuffer(
  args: string[],
  callerOptions: Parameters<typeof gitExecFileAsyncBufferInSpan>[1]
): Promise<{ stdout: Buffer }> {
  const options = routeLocalGitOptions(callerOptions)
  return runAdmittedWslGit(options, () =>
    runUnlessGitCwdKnownMissing(options, () => gitExecFileAsyncBufferInSpan(args, options))
  )
}
