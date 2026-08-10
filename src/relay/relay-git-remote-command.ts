import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import {
  cleanupSpawnedProcessTree,
  preserveProcessCleanupFailure
} from '../shared/spawned-process-tree-cleanup'

type RelayGitRemoteCommandOptions = {
  cleanupDeadlineMs?: number
  cwd: string
  env: NodeJS.ProcessEnv
  maxBuffer: number
  signal?: AbortSignal
  timeout: number
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function commandFailure(args: string[], stderr: string, code: number | null): Error {
  const detail = stderr.trim()
  return new Error(
    detail
      ? `Command failed: git ${args.join(' ')}\n${detail}`
      : `Command failed: git ${args.join(' ')} (exit ${code ?? 'unknown'})`
  )
}

export function runRelayGitRemoteCommand(
  args: string[],
  options: RelayGitRemoteCommandOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }

    const child = spawn('git', args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminating = false

    const timeout = setTimeout(() => {
      terminate(new Error('git timed out.'))
    }, options.timeout)
    timeout.unref?.()

    const cleanup = (): void => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
    }
    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      cleanup()
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    }
    function onAbort(): void {
      terminate(abortError())
    }
    function terminate(error: Error): void {
      if (settled || terminating) {
        return
      }
      terminating = true
      cleanup()
      child.stdout?.pause()
      child.stderr?.pause()
      void cleanupSpawnedProcessTree(child, {
        deadlineMs: options.cleanupDeadlineMs,
        killPosixProcessGroup: true
      }).then((result) => {
        terminating = false
        finish(preserveProcessCleanupFailure(error, result))
      })
    }
    function onStdout(chunk: Buffer): void {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxBuffer) {
        terminate(new Error('git stdout exceeded maxBuffer.'))
        return
      }
      stdout += stdoutDecoder.write(chunk)
    }
    function onStderr(chunk: Buffer): void {
      stderrBytes += chunk.byteLength
      if (stderrBytes > options.maxBuffer) {
        terminate(new Error('git stderr exceeded maxBuffer.'))
        return
      }
      stderr += stderrDecoder.write(chunk)
    }
    function onError(error: Error): void {
      terminate(error)
    }
    function onClose(code: number | null): void {
      if (terminating) {
        return
      }
      if (code === 0) {
        finish(null)
        return
      }
      terminate(commandFailure(args, stderr, code))
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
    }
  })
}
