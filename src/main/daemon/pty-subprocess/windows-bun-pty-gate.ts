import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { win32 } from 'node:path'
import { spawnProcess, type ProcessSpec } from '../../../shared/child-process/run-process'

export const WINDOWS_BUN_PTY_GATE_ENV = 'ORCA_BUN_PTY_JOB_GATE'
export const WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS = ['NODE_OPTIONS', 'BUN_OPTIONS'] as const

export type WindowsBunPtyGateRequest = {
  file: string
  args: string[]
  cwd: string
  gatePath: string
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
  const request = value as WindowsBunPtyGateRequest | null
  if (
    !request ||
    typeof request.file !== 'string' ||
    !request.file ||
    !Array.isArray(request.args) ||
    request.args.some((arg) => typeof arg !== 'string') ||
    typeof request.cwd !== 'string' ||
    !request.cwd ||
    typeof request.gatePath !== 'string' ||
    !request.gatePath ||
    !request.runtimeOptions ||
    typeof request.runtimeOptions !== 'object' ||
    Object.entries(request.runtimeOptions).some(
      ([key, value]) =>
        !WINDOWS_BUN_PTY_RUNTIME_OPTION_KEYS.includes(key as 'NODE_OPTIONS' | 'BUN_OPTIONS') ||
        typeof value !== 'string'
    )
  ) {
    throw new Error('Invalid Windows PTY gate request')
  }
  return request
}

export async function waitForWindowsBunPtyJobGate(gatePath: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      unlinkSync(gatePath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
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
  } = {}
): Promise<number> {
  await (deps.waitForGate ?? waitForWindowsBunPtyJobGate)(request.gatePath)
  return new Promise((resolve, reject) => {
    const child = (deps.spawn ?? spawnProcess)(
      windowsBunPtyChildSpec(request, deps.env ?? process.env)
    )
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
