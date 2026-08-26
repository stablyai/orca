import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { withGitSpan } from '../../observability/instrumentation'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from '../wsl-linked-worktree-git-routing'
import { createAbortError } from './abort-error'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import type { ResolvedCommand } from './wsl-command-resolution'
import { DEFAULT_GIT_MAX_BUFFER, type GitExecOptions } from './git-exec-options'
import {
  directWslGitExitCode,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand,
  resolveGitCommandWithoutProbe
} from './git-command-resolution'
import { prepareWindowsHostGitEnvironment } from './windows-host-git-environment'
import { nonInteractiveGitEnv, untranslatedGitOutputEnv } from './git-process-env'
import { gitSpawn } from './git-spawn'

/** Result of a streamed git command; `stoppedEarly` is true when onStdout asked to stop before the child exited. */
export type GitStreamResult = { stoppedEarly: boolean }

export type GitStreamOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  preferWslDirectGit?: boolean
  signal?: AbortSignal
  /** Byte backstop; defaults to DEFAULT_GIT_MAX_BUFFER. */
  maxBuffer?: number
  /**
   * Called for each decoded stdout chunk. Return true to stop: the child is
   * killed and the promise resolves with stoppedEarly=true.
   */
  onStdout: (chunk: string) => boolean | void
}

/**
 * Stream a git command's stdout incrementally instead of buffering it whole.
 *
 * Why: output larger than V8's max string (e.g. status on a repo with a huge
 * un-ignored folder) crashes the process when buffered; streaming keeps memory
 * bounded and lets the parser stop git early. Built on gitSpawn for WSL routing.
 */
export async function gitStreamStdout(
  args: string[],
  options: GitStreamOptions
): Promise<GitStreamResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER
  return withGitSpan({ args, cwd: options.cwd }, async () => {
    if (isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)) {
      await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro, {
        signal: options.signal
      })
    }
    const gitOptions: GitExecOptions = {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.preferWslDirectGit ? { preferWslDirectGit: true } : {}),
      ...(options.signal ? { signal: options.signal } : {})
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
        let child: ChildProcess
        if (command.wslMode === 'direct-git') {
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

        let settled = false
        let stoppedEarly = false
        let stdoutBytes = 0
        let stderr = ''
        let stderrBytes = 0
        // Why: decode statefully so a multibyte UTF-8 char split across chunks isn't corrupted into replacement chars.
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')

        const cleanup = (): void => {
          child.stdout?.off('data', onStdoutData)
          child.stderr?.off('data', onStderrData)
          child.off('error', onError)
          child.off('close', onClose)
          options.signal?.removeEventListener('abort', onAbort)
          // Flush any bytes the decoders were holding for an incomplete sequence.
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
            void killSpawnedCommandTree(child)
            finish(new Error('git stdout exceeded maxBuffer.'))
            return
          }
          const decoded = stdoutDecoder.write(chunk)
          if (decoded.length === 0) {
            return
          }
          // Why: a throw from the caller's parser would escape this event handler and crash main; convert to a rejection.
          let shouldStop: boolean | void
          try {
            shouldStop = options.onStdout(decoded)
          } catch (error) {
            void killSpawnedCommandTree(child)
            finish(error instanceof Error ? error : new Error(String(error)))
            return
          }
          if (shouldStop === true) {
            // Parser hit its limit: kill git and resolve cleanly with the partial output.
            stoppedEarly = true
            void killSpawnedCommandTree(child)
            finish(null)
          }
        }
        function onStderrData(chunk: Buffer): void {
          stderrBytes += chunk.byteLength
          if (stderrBytes > maxBuffer) {
            void killSpawnedCommandTree(child)
            finish(new Error('git stderr exceeded maxBuffer.'))
            return
          }
          stderr += stderrDecoder.write(chunk)
        }
        function onError(error: Error): void {
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
          if (!child.pid) {
            // Why: failed spawn reports ENOENT after abort cleanup; retain a listener so it cannot crash main.
            child.once('error', () => {})
          }
          void killSpawnedCommandTree(child)
          finish(createAbortError())
        }

        child.stdout?.on('data', onStdoutData)
        child.stderr?.on('data', onStderrData)
        child.on('error', onError)
        child.on('close', onClose)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted) {
          onAbort()
        }
      })
    try {
      return await stream(resolved)
    } catch (error) {
      const stdoutBytes =
        error && typeof error === 'object' ? (error as { stdoutBytes?: unknown }).stdoutBytes : null
      if (
        stdoutBytes === 0 &&
        directWslGitExitCode(error, resolved) !== null &&
        !options.signal?.aborted
      ) {
        const wasMissing = invalidateMissingDirectWslGit(error, resolved)
        resolved = resolveGitCommandWithoutProbe(args, gitOptions)
        const result = await stream(resolved)
        disableDirectWslGitAfterSuccessfulFallback(wasMissing, resolved)
        return result
      }
      throw error
    }
  })
}
