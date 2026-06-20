import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

type RelayGitRemoteCommandOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  maxBuffer: number
  signal?: AbortSignal
  timeout: number
}

const FORCE_KILL_DELAY_MS = 2_000

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function terminateGitProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.once('error', () => child.kill())
      killer.unref()
    } catch {
      child.kill()
    }
    return
  }
  try {
    // Why: a remote Git command can leave ssh, credential helpers, or hooks
    // behind; detached groups let cancellation terminate all descendants.
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill()
    return
  }
  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  }, FORCE_KILL_DELAY_MS)
  child.once('close', () => clearTimeout(forceKillTimer))
  forceKillTimer.unref?.()
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

    const timeout = setTimeout(() => {
      terminateGitProcessTree(child)
      finish(new Error('git timed out.'))
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
      if (settled) {
        return
      }
      terminateGitProcessTree(child)
      finish(abortError())
    }
    function onStdout(chunk: Buffer): void {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxBuffer) {
        terminateGitProcessTree(child)
        finish(new Error('git stdout exceeded maxBuffer.'))
        return
      }
      stdout += stdoutDecoder.write(chunk)
    }
    function onStderr(chunk: Buffer): void {
      stderrBytes += chunk.byteLength
      if (stderrBytes > options.maxBuffer) {
        terminateGitProcessTree(child)
        finish(new Error('git stderr exceeded maxBuffer.'))
        return
      }
      stderr += stderrDecoder.write(chunk)
    }
    function onError(error: Error): void {
      finish(error)
    }
    function onClose(code: number | null): void {
      finish(code === 0 ? null : commandFailure(args, stderr, code))
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
