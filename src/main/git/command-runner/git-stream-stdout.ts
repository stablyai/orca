import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { spawnNativeProcess } from '@orca/process-host/native-process-spawn'
import { createPosixGroupTermination } from '@orca/process-host/posix-group-termination'
import { StringDecoder } from 'node:string_decoder'
import { withGitSpan } from '../../observability/instrumentation'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { createAbortError } from './process-capture/abort-error'
import { killSpawnedCommandTree } from './process-capture/spawned-command-tree-kill'
import { pendingWslDriveCheckoutGitRouting } from './host-routing/wsl-drive-checkout-git-routing'
import type { ResolvedCommand } from './host-routing/wsl-command-resolution'
import {
  DEFAULT_GIT_MAX_BUFFER,
  type GitExecOptions,
  type GitStreamOptions,
  type GitStreamResult
} from './git-exec-options'

import {
  pendingWslDirectGitReadEnvironment,
  directWslGitExitCode,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand,
  resolveGitCommandWithoutProbe
} from './host-routing/git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './host-routing/windows-host-git-environment'
import { nonInteractiveGitEnv, untranslatedGitOutputEnv } from './git-environment/git-process-env'
import { gitSpawn } from './git-spawn'
import { acquireGitAdmission } from './admission/git-subprocess-admission'
import {
  GitCommandTimeoutError,
  gitCommandTimeoutMs
} from '../../../shared/git/commands/git-command-timeout'
import { routeLocalGitOptions, runAdmittedWslGit } from './host-routing/local-git-runtime-route'
import { gitRunsIn } from './host-routing/git-runs-in'

export type { GitStreamResult, GitStreamOptions } from './git-exec-options'

/** Stream bounded stdout so large repositories cannot overflow V8 and parsers can stop early. */
export async function gitStreamStdout(
  args: string[],
  callerOptions: GitStreamOptions
): Promise<GitStreamResult> {
  const options = routeLocalGitOptions(callerOptions)
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER
  const timeoutMs = gitCommandTimeoutMs(args, options.timeoutMs, options.timeoutMsForTest)
  return runAdmittedWslGit(options, () => streamInSpan(args, options, maxBuffer, timeoutMs))
}

function streamInSpan(
  args: string[],
  options: GitStreamOptions,
  maxBuffer: number,
  timeoutMs: number | undefined
): Promise<GitStreamResult> {
  const meta = { args, cwd: options.cwd, admissionTier: options.admissionTier }
  return withGitSpan(meta, async (span) => {
    const checkoutRoutingReady = pendingWslDriveCheckoutGitRouting(args, options)
    if (checkoutRoutingReady) {
      await checkoutRoutingReady
    }
    const gitOptions: GitExecOptions = {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.preferWslDirectGit ? { preferWslDirectGit: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    }
    const readEnvironmentReady = pendingWslDirectGitReadEnvironment(args, gitOptions)
    if (readEnvironmentReady) {
      await readEnvironmentReady
    }
    let resolved = resolveGitCommand(args, gitOptions)
    const environmentReady = prepareWindowsHostGitEnvironment(
      resolved,
      gitOptions.env,
      options.signal
    )
    if (environmentReady) {
      gitOptions.env = await environmentReady
    }
    resolved = resolveGitCommand(args, gitOptions)
    const grant = await acquireGitAdmission({
      args,
      cwd: options.cwd,
      wslDistro: options.wslDistro,
      tier: options.admissionTier,
      signal: options.signal
    })
    span?.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
    span?.setAttribute('git.runs_in', gitRunsIn(resolved))
    const terminationState: { current: Promise<void> | null } = { current: null }
    const stream = (command: ResolvedCommand): Promise<GitStreamResult> =>
      new Promise<GitStreamResult>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(createAbortError())
          return
        }
        const stdio: SpawnOptions['stdio'] = ['ignore', 'pipe', 'pipe']
        const spawnOptions = {
          cwd: options.cwd,
          env: nonInteractiveGitEnv(gitOptions.env),
          stdio,
          wslDistro: options.wslDistro,
          windowsHide: true
        }
        const ownedPosixGroup = process.platform !== 'win32' && !command.wsl
        let child: ChildProcess
        if (ownedPosixGroup) {
          child = spawnNativeProcess(
            command.binary,
            command.args,
            {
              cwd: command.cwd,
              env: untranslatedGitOutputEnv(spawnOptions.env),
              stdio,
              windowsHide: true,
              detached: true
            },
            undefined,
            recordSubprocessSpawn
          )
        } else if (command.wslMode === 'direct-git') {
          const spawnStartedAt = performance.now()
          child = spawn(command.binary, command.args, {
            cwd: command.cwd,
            env: untranslatedGitOutputEnv(spawnOptions.env),
            stdio: spawnOptions.stdio,
            windowsHide: true
          })
          recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
        } else {
          child = gitSpawn(args, spawnOptions)
        }
        let stopping = false
        let groupTermination: ReturnType<typeof createPosixGroupTermination> | undefined
        let terminationReported = false
        terminationState.current = new Promise<void>((resolveTermination) => {
          const reportTermination = (): void => {
            if (terminationReported) {
              return
            }
            terminationReported = true
            resolveTermination()
          }
          if (ownedPosixGroup) {
            groupTermination = createPosixGroupTermination(child, reportTermination)
            child.once('close', groupTermination.close)
          } else {
            child.once('close', reportTermination)
          }
          child.once('error', () => {
            if (!child.pid) {
              reportTermination()
            }
          })
        })

        // Retain an error observer after parser cleanup, including failed-spawn races.
        child.on('error', () => {})
        child.stdout?.on('error', () => {})
        child.stderr?.on('error', () => {})
        const stopChild = (): void => {
          if (stopping) {
            return
          }
          stopping = true
          if (groupTermination) {
            void groupTermination.stop()
          } else {
            void killSpawnedCommandTree(child)
          }
        }

        let settled = false
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null
        let stoppedEarly = false
        let stdoutBytes = 0
        let stderr = ''
        let stderrBytes = 0
        // Decode across chunk boundaries to preserve split UTF-8 characters.
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')

        const cleanup = (): void => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          child.stdout?.off('data', onStdoutData)
          child.stderr?.off('data', onStderrData)
          child.off('error', onError)
          child.off('close', onClose)
          options.signal?.removeEventListener('abort', onAbort)
          stdoutDecoder.end()
          stderrDecoder.end()
        }
        const finish = (error: Error | null): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          if (error) {
            reject(Object.assign(error, { stderr, stdoutBytes }))
            return
          }
          resolve({ stoppedEarly })
        }

        function onStdoutData(chunk: Buffer): void {
          stdoutBytes += chunk.byteLength
          if (stdoutBytes > maxBuffer) {
            stopChild()
            finish(new Error('git stdout exceeded maxBuffer.'))
            return
          }
          const decoded = stdoutDecoder.write(chunk)
          if (decoded.length === 0) {
            return
          }
          // Reject parser failures rather than letting stream callbacks crash main.
          let shouldStop: boolean | void
          try {
            shouldStop = options.onStdout(decoded)
          } catch (error) {
            stopChild()
            finish(error instanceof Error ? error : new Error(String(error)))
            return
          }
          if (shouldStop === true) {
            stoppedEarly = true
            stopChild()
            finish(null)
          }
        }
        function onStderrData(chunk: Buffer): void {
          stderrBytes += chunk.byteLength
          if (stderrBytes > (options.maxStderrBuffer ?? maxBuffer)) {
            stopChild()
            finish(new Error('git stderr exceeded maxBuffer.'))
            return
          }
          stderr += stderrDecoder.write(chunk)
        }
        function onError(error: Error): void {
          if (groupTermination && child.pid) {
            stopChild()
          }
          finish(error)
        }
        function onClose(code: number | null): void {
          if (stoppedEarly || code === 0) {
            finish(null)
            return
          }
          finish(Object.assign(new Error(`git exited with ${code}: ${stderr}`), { code }))
        }
        function onAbort(): void {
          stopChild()
          finish(createAbortError())
        }

        function onTimeout(): void {
          stopChild()
          finish(new GitCommandTimeoutError(timeoutMs as number))
        }

        child.stdout?.on('data', onStdoutData)
        child.stderr?.on('data', onStderrData)
        child.on('error', onError)
        child.on('close', onClose)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timeoutTimer = setTimeout(onTimeout, timeoutMs)
        }
        if (options.signal?.aborted) {
          onAbort()
        }
      })
    try {
      try {
        return await stream(resolved)
      } catch (error) {
        const stdoutBytes =
          error && typeof error === 'object'
            ? (error as { stdoutBytes?: unknown }).stdoutBytes
            : null
        if (
          stdoutBytes === 0 &&
          directWslGitExitCode(error, resolved) !== null &&
          !options.signal?.aborted
        ) {
          await terminationState.current
          const wasMissing = invalidateMissingDirectWslGit(error, resolved)
          resolved = resolveGitCommandWithoutProbe(args, gitOptions)
          const result = await stream(resolved)
          disableDirectWslGitAfterSuccessfulFallback(wasMissing, resolved)
          return result
        }
        throw error
      }
    } finally {
      const termination = terminationState.current
      if (termination) {
        void termination.then(grant.release)
      } else {
        grant.release()
      }
    }
  })
}
