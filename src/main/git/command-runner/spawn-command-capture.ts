import { spawn } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { getSpawnArgsForWindows } from '../../win32-utils'
import { createAbortError } from './abort-error'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'

export type CommandExecOptions = {
  cwd?: string
  encoding?: BufferEncoding
  maxBuffer?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  wslDistro?: string
}

export async function spawnCommandCapture(
  command: string,
  args: string[],
  options: CommandExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError())
      return
    }
    let settled = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const spawnStartedAt = performance.now()
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    recordSubprocessSpawn(spawnCmd, spawnArgs, performance.now() - spawnStartedAt)
    let timer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      void killSpawnedCommandTree(child)
      finish(createAbortError())
    }
    const cleanupListeners = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onStdoutData)
      child.stderr?.off('data', onStderrData)
      child.off('error', onError)
      child.off('close', onClose)
    }
    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    }
    timer = options.timeout
      ? setTimeout(() => {
          void killSpawnedCommandTree(child)
          finish(new Error(`${command} timed out.`))
        }, options.timeout)
      : null
    options.signal?.addEventListener('abort', onAbort, { once: true })
    function onStdoutData(chunk: Buffer): void {
      stdoutBytes += chunk.byteLength
      if (options.maxBuffer && stdoutBytes > options.maxBuffer) {
        void killSpawnedCommandTree(child)
        finish(new Error(`${command} stdout exceeded maxBuffer.`))
        return
      }
      stdout += chunk.toString(options.encoding ?? 'utf-8')
    }
    function onStderrData(chunk: Buffer): void {
      stderrBytes += chunk.byteLength
      if (options.maxBuffer && stderrBytes > options.maxBuffer) {
        void killSpawnedCommandTree(child)
        finish(new Error(`${command} stderr exceeded maxBuffer.`))
        return
      }
      stderr += chunk.toString(options.encoding ?? 'utf-8')
    }
    function onError(error: Error): void {
      finish(error)
    }
    function onClose(code: number | null): void {
      if (code === 0) {
        finish(null)
        return
      }
      finish(new Error(`${command} exited with ${code}.`))
    }
    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
  })
}
