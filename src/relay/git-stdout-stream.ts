import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { expandTilde } from './context'
import { buildRelayGitEnv } from './relay-command-env'
import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

const DEFAULT_RELAY_GIT_STREAM_MAX_BYTES = 10 * 1024 * 1024

export type RelayGitStreamOptions = {
  disableOptionalLocks?: boolean
  signal?: AbortSignal
  maxBuffer?: number
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
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError())
      return
    }

    const env = buildRelayGitEnv()
    if (options.disableOptionalLocks) {
      env.GIT_OPTIONAL_LOCKS = '0'
    }

    let child
    try {
      child = spawn('git', args, {
        cwd: expandTilde(cwd),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
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

    const cleanup = (): void => {
      child.stdout.off('data', onStdoutData)
      child.stderr.off('data', onStderrData)
      child.off('error', onError)
      child.off('close', onClose)
      options.signal?.removeEventListener('abort', onAbort)
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
    const stopWithError = (error: Error): void => {
      terminateRelaySubprocessTree(child)
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
          terminateRelaySubprocessTree(child)
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
      finish(error)
    }
    function onClose(code: number | null): void {
      if (stoppedEarly || code === 0) {
        finish()
      } else {
        finish(new Error(`git exited with ${code}: ${stderr}`))
      }
    }
    function onAbort(): void {
      if (!child.pid) {
        // Why: failed spawn reports ENOENT after abort cleanup; handle it so it cannot crash the relay.
        child.once('error', () => {})
      }
      stopWithError(createAbortError())
    }

    child.stdout.on('data', onStdoutData)
    child.stderr.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
    }
  })
}
