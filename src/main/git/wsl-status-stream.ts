import { StringDecoder } from 'node:string_decoder'
import { withGitSpan } from '../observability/instrumentation'
import {
  DEFAULT_GIT_MAX_BUFFER,
  gitStreamStdout,
  killSpawnedCommandTree,
  nonInteractiveGitEnv,
  wslAwareSpawn,
  type GitStreamResult
} from './runner'
import { invalidateWslStatusEnvironment } from './wsl-status-environment'
import {
  directWslGitArgs,
  isCachedGitUnavailable,
  loginShellWslGitArgs,
  readWslStatusEnvironment,
  resolveWslStatusTarget,
  type WslStatusGitOptions
} from './wsl-status-runner'

type WslStatusStreamOptions = WslStatusGitOptions & {
  onStdout: (chunk: string) => boolean | void
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function streamWslGit(
  resolvedArgs: string[],
  spawnEnv: NodeJS.ProcessEnv,
  options: WslStatusStreamOptions
): Promise<GitStreamResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER
  return new Promise<GitStreamResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError())
      return
    }
    const child = wslAwareSpawn('wsl.exe', resolvedArgs, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let settled = false
    let stoppedEarly = false
    let sawStdout = false
    let stdoutBytes = 0
    let stderrBytes = 0
    let stderr = ''
    let timer: NodeJS.Timeout | null = null
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
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
        reject(Object.assign(error, { stderr, sawStdout }))
        return
      }
      resolve({ stoppedEarly })
    }
    function onStdoutData(chunk: Buffer): void {
      sawStdout ||= chunk.byteLength > 0
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxBuffer) {
        killSpawnedCommandTree(child)
        finish(new Error('git stdout exceeded maxBuffer.'))
        return
      }
      const decoded = stdoutDecoder.write(chunk)
      try {
        if (decoded && options.onStdout(decoded) === true) {
          stoppedEarly = true
          killSpawnedCommandTree(child)
          finish(null)
        }
      } catch (error) {
        killSpawnedCommandTree(child)
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    function onStderrData(chunk: Buffer): void {
      stderrBytes += chunk.byteLength
      if (stderrBytes > maxBuffer) {
        killSpawnedCommandTree(child)
        finish(new Error('git stderr exceeded maxBuffer.'))
        return
      }
      stderr += stderrDecoder.write(chunk)
    }
    function onError(error: Error): void {
      finish(error)
    }
    function onClose(code: number | null): void {
      const error = Object.assign(new Error(`git exited with ${code}: ${stderr}`), { code })
      finish(stoppedEarly || code === 0 ? null : error)
    }
    function onAbort(): void {
      killSpawnedCommandTree(child)
      finish(createAbortError())
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = options.timeout
      ? setTimeout(() => {
          killSpawnedCommandTree(child)
          finish(new Error('wsl.exe timed out.'))
        }, options.timeout)
      : null
    if (options.signal?.aborted) {
      onAbort()
    }
  })
}

export async function gitStatusStreamStdout(
  args: string[],
  options: WslStatusStreamOptions
): Promise<GitStreamResult> {
  const target = resolveWslStatusTarget(options)
  if (!target) {
    return gitStreamStdout(args, options)
  }
  return withGitSpan({ args, cwd: options.cwd }, async () => {
    const spawnEnv = nonInteractiveGitEnv(options.env)
    const loginShellFallback = (): Promise<GitStreamResult> =>
      streamWslGit(loginShellWslGitArgs(target, args, spawnEnv), spawnEnv, options)
    const environment = await readWslStatusEnvironment(target, options.signal)
    if (!environment) {
      return loginShellFallback()
    }
    try {
      return await streamWslGit(
        directWslGitArgs(target, environment, args, spawnEnv),
        spawnEnv,
        options
      )
    } catch (error) {
      const detail = error as { sawStdout?: unknown }
      if (
        options.signal?.aborted ||
        detail.sawStdout === true ||
        !isCachedGitUnavailable(error, environment.gitPath)
      ) {
        throw error
      }
      invalidateWslStatusEnvironment(target.distro, environment)
      return loginShellFallback()
    }
  })
}
