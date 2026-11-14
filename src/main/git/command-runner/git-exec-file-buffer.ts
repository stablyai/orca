import { withGitSpan } from '../../observability/instrumentation'
import {
  pendingWslGitPathPreparation,
  captureGitExecutionContext,
  assertPreparedGitCommand,
  gitResultWithExecutionContext
} from './host-routing/wsl-git-path-preparation'
import type { GitBufferExecOptions } from './git-exec-options'
import {
  pendingWslDirectGitReadEnvironment,
  resolveGitCommand
} from './host-routing/git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './host-routing/windows-host-git-environment'
import { acquireGitAdmission, releaseGitAdmissionAfter } from './admission/git-subprocess-admission'
import {
  GitCommandTimeoutError,
  gitCommandTimeoutMs
} from '../../../shared/git/commands/git-command-timeout'
import { execFileCapture } from './process-capture/exec-file-capture'
import { untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { readCapturedGitBuffer } from './process-capture/captured-git-output'
import { routeLocalGitOptions, runAdmittedWslGit } from './host-routing/local-git-runtime-route'
import { runUnlessGitCwdKnownMissing } from './host-routing/missing-git-spawn-cwd'
import { gitRunsIn } from './host-routing/git-runs-in'

async function gitExecFileAsyncBufferInSpan(
  args: string[],
  options: GitBufferExecOptions
): Promise<{ stdout: Buffer }> {
  const meta = { args, cwd: options.cwd, admissionTier: options.admissionTier }
  return withGitSpan(meta, async (span) => {
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
      assertPreparedGitCommand(resolved, args, options)
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
      return gitResultWithExecutionContext(
        { stdout: readCapturedGitBuffer(stdout, resolved) },
        resolved.executionContext
      )
    } finally {
      releaseGitAdmissionAfter(termination, grant)
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
