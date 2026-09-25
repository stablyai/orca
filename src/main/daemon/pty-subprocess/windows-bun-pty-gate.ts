import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { win32 } from 'node:path'
import { spawnProcess, type ProcessSpec } from '../../../shared/child-process/run-process'
import {
  publishWindowsBunPtyShellPid,
  publishWindowsBunPtySpawnError
} from './windows-bun-pty-spawn-receipt'

export const WINDOWS_BUN_PTY_GATE_ENV = 'ORCA_BUN_PTY_JOB_GATE'
export const WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS = ['NODE_OPTIONS', 'BUN_OPTIONS'] as const

export type WindowsBunPtyGateRequest = {
  file: string
  args: string[]
  cwd: string
  gatePath: string
  shellPidPath: string
  runtimeOptions: Partial<Record<(typeof WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS)[number], string>>
}

export function readWindowsBunPtyGateRequest(path: string): WindowsBunPtyGateRequest {
  if (statSync(path).size > 1024 * 1024) {
    throw new Error('Windows PTY gate request exceeds its size limit')
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Invalid Windows PTY gate request')
  }
  const request = value
  if (
    typeof request !== 'object' ||
    request === null ||
    !('file' in request) ||
    typeof request.file !== 'string' ||
    !request.file ||
    !('args' in request) ||
    !Array.isArray(request.args) ||
    !request.args.every((arg): arg is string => typeof arg === 'string') ||
    !('cwd' in request) ||
    typeof request.cwd !== 'string' ||
    !request.cwd ||
    !('gatePath' in request) ||
    typeof request.gatePath !== 'string' ||
    !request.gatePath ||
    !('shellPidPath' in request) ||
    typeof request.shellPidPath !== 'string' ||
    !request.shellPidPath ||
    !('runtimeOptions' in request) ||
    typeof request.runtimeOptions !== 'object' ||
    request.runtimeOptions === null ||
    Array.isArray(request.runtimeOptions)
  ) {
    throw new Error('Invalid Windows PTY gate request')
  }
  const runtimeOptions: WindowsBunPtyGateRequest['runtimeOptions'] = {}
  for (const [key, value] of Object.entries(request.runtimeOptions)) {
    if ((key !== 'NODE_OPTIONS' && key !== 'BUN_OPTIONS') || typeof value !== 'string') {
      throw new Error('Invalid Windows PTY gate request')
    }
    runtimeOptions[key] = value
  }
  return {
    file: request.file,
    args: request.args,
    cwd: request.cwd,
    gatePath: request.gatePath,
    shellPidPath: request.shellPidPath,
    runtimeOptions
  }
}

export async function waitForWindowsBunPtyJobGate(gatePath: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      unlinkSync(gatePath)
      return
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('Windows PTY job assignment timed out')
    }
    await delay(5)
  }
}

export function windowsBunPtyChildSpec(
  request: WindowsBunPtyGateRequest,
  inheritedEnv: NodeJS.ProcessEnv
): ProcessSpec {
  const env: NodeJS.ProcessEnv = { ...inheritedEnv, ...request.runtimeOptions }
  delete env[WINDOWS_BUN_PTY_GATE_ENV]
  delete env.ORCA_BUN_PTY_CHILD_COMMAND
  return {
    program: request.file,
    args: request.args,
    cwd: request.cwd,
    env,
    stdio: 'inherit',
    // cmd owns the command text following /K or /C; it must not receive CRT argv escaping.
    ...(win32.basename(request.file).toLowerCase() === 'cmd.exe'
      ? { windowsVerbatimArguments: true }
      : {})
  }
}

export async function runWindowsBunPtyGate(
  request: WindowsBunPtyGateRequest,
  deps: {
    waitForGate?: (gatePath: string) => Promise<void>
    spawn?: typeof spawnProcess
    env?: NodeJS.ProcessEnv
    reportShellPid?: (pid: number) => void
    reportSpawnError?: (error: unknown) => void
  } = {}
): Promise<number> {
  let spawned = false
  try {
    await (deps.waitForGate ?? waitForWindowsBunPtyJobGate)(request.gatePath)
    return await new Promise<number>((resolve, reject) => {
      const child = (deps.spawn ?? spawnProcess)(
        windowsBunPtyChildSpec(request, deps.env ?? process.env)
      )
      child.once('spawn', () => {
        spawned = true
        if (child.pid !== undefined) {
          const report =
            deps.reportShellPid ??
            ((pid) => publishWindowsBunPtyShellPid(request.shellPidPath, pid))
          try {
            report(child.pid)
          } catch (error) {
            // Keep supervising the shell; absent identity must remain unverifiable.
            console.warn('[pty] Failed to publish Windows shell identity:', error)
          }
        }
      })
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } catch (error) {
    if (!spawned) {
      try {
        const report =
          deps.reportSpawnError ??
          ((error) => publishWindowsBunPtySpawnError(request.shellPidPath, error))
        report(error)
      } catch (receiptError) {
        console.warn('[pty] Failed to publish Windows shell spawn error:', receiptError)
      }
    }
    throw error
  }
}
