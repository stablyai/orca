import { StringDecoder } from 'node:string_decoder'
import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { createChildTerminationReporter } from '@orca/process-host/child-termination-reporter'
import { GitCommandTimeoutError, gitCommandTimeoutMs } from '../shared/git-command-timeout'
import { expandTilde } from './context'
import { buildRelayGitEnv } from '../wsl-guest/relay-command-env'
import { acquireRelayGitAdmission } from './git-handler-command-termination'

const DEFAULT_RELAY_GIT_STREAM_MAX_BYTES = 10 * 1024 * 1024

export type RelayGitStreamOptions = {
  disableOptionalLocks?: boolean
  signal?: AbortSignal
  maxBuffer?: number
  timeout?: number
  onStdout: (chunk: string) => boolean | void
}

export type RelayGitStreamExec = (
  args: string[],
  cwd: string,
  options: RelayGitStreamOptions
) => Promise<{ stoppedEarly: boolean }>

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** Stream Git stdout on the relay host and allow the consumer to stop it early. */
export const streamRelayGitStdout: RelayGitStreamExec = async (args, cwd, options) => {
  const maxBuffer = options.maxBuffer ?? DEFAULT_RELAY_GIT_STREAM_MAX_BYTES
  const resolvedCwd = expandTilde(cwd)
  const grant = await acquireRelayGitAdmission({ args, cwd: resolvedCwd, signal: options.signal })
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      grant.release()
      reject(createAbortError())
      return
    }

    const termination = createChildTerminationReporter(grant.release)
    let child
    try {
      const env = buildRelayGitEnv()
      if (options.disableOptionalLocks) {
        env.GIT_OPTIONAL_LOCKS = '0'
      }
      child = spawnProcess({
        program: 'git',
        args,
        cwd: resolvedCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      termination.report()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    let settled = false
    let stoppedEarly = false
    let stdoutBytes = 0
    let stderrBytes = 0
    let stderr = ''
    // Why: filenames may contain UTF-8 characters split across stream chunks;
    // stateful decoding keeps the porcelain record intact.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let deadline: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      child.stdout.off('data', onStdoutData)
      child.stderr.off('data', onStderrData)
      options.signal?.removeEventListener('abort', onAbort)
      clearTimeout(deadline)
      stdoutDecoder.end()
      stderrDecoder.end()
    }
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(Object.assign(error, { stderr }))
      } else {
        resolve({ stoppedEarly })
      }
    }
    // Parser completion leaves the child holding admission until termination is observed.
    const releaseChild = (): void => {
      termination.report()
      child.off('error', onError)
      child.off('close', onClose)
      child.stdout.off('error', onError)
      child.stderr.off('error', onError)
    }
    const stopWithError = (error: Error): void => {
      void forceTerminateProcessTree(child).catch(() => {})
      finish(error)
    }

    function onStdoutData(chunk: Buffer): void {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxBuffer) {
        stopWithError(new Error('git stdout exceeded maxBuffer.'))
        return
      }
      const decoded = stdoutDecoder.write(chunk)
      if (!decoded) {
        return
      }
      try {
        if (options.onStdout(decoded) === true) {
          // Why: the status cap is a successful partial result, so detach and
          // resolve immediately after stopping Git instead of awaiting close.
          stoppedEarly = true
          void forceTerminateProcessTree(child).catch(() => {})
          finish()
        }
      } catch (error) {
        stopWithError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    function onStderrData(chunk: Buffer): void {
      stderrBytes += chunk.byteLength
      if (stderrBytes > maxBuffer) {
        stopWithError(new Error('git stderr exceeded maxBuffer.'))
        return
      }
      stderr += stderrDecoder.write(chunk)
    }
    function onError(error: Error): void {
      if (!child.pid) {
        releaseChild()
      }
      if (!settled && child.pid) {
        void forceTerminateProcessTree(child).catch(() => {})
      }
      finish(error)
    }
    function onClose(code: number | null): void {
      releaseChild()
      if (stoppedEarly || code === 0) {
        finish()
      } else {
        finish(new Error(`git exited with ${code}: ${stderr}`))
      }
    }
    function onAbort(): void {
      stopWithError(createAbortError())
    }

    child.stdout.on('data', onStdoutData)
    child.stderr.on('data', onStderrData)
    child.stdout.on('error', onError)
    child.stderr.on('error', onError)
    child.on('error', onError)
    child.on('close', onClose)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = gitCommandTimeoutMs(args, options.timeout)
    if (timeoutMs !== undefined && timeoutMs > 0) {
      deadline = setTimeout(() => {
        stopWithError(Object.assign(new GitCommandTimeoutError(timeoutMs), { timedOut: true }))
      }, timeoutMs)
      deadline.unref()
    }
    if (options.signal?.aborted) {
      onAbort()
    }
  })
}
