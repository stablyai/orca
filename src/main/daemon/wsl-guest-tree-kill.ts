import { win32 as pathWin32 } from 'node:path'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../shared/child-process/run-process'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { isUsablePtyTreeMarker } from '../pty/wsl-orca-env'
import { filterUserWslDistros, parseWslDistros } from '../wsl-distro-list-output'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { resolveBundledGuestTreeKillArtifact } from '../pty/bundled-guest-tree-kill'
import {
  buildWslGuestTreeKillArgs,
  buildWslGuestTreeKillInput
} from './wsl-guest-tree-kill-command'
export { buildWslGuestTreeKillArgs } from './wsl-guest-tree-kill-command'

export const WSL_GUEST_TREE_KILL_TIMEOUT_MS = 4_000
const WSL_GUEST_STARTUP_RESERVE_MS = 750
const WSL_RUNNING_PROBE_TIMEOUT_MS = 1_000

function rootCleanupEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WSLENV: '', WSL_UTF8: '1' }
  for (const name of Object.keys(env)) {
    if (/^(?:LD_|PYTHON)/i.test(name) || name.toUpperCase() === 'WSLENV') {
      delete env[name]
    }
  }
  // The ELF loader runs before env -i; never import caller-selected guest variables.
  env.WSLENV = ''
  return env
}

export type WslGuestTreeKillRunner = (spec: ProcessSpec) => Promise<ProcessResult>

async function beforeDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('WSL guest cleanup deadline elapsed'))
        }, timeoutMs)
      }),
      run(controller.signal)
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Best-effort only: completion is never evidence that the guest tree exited. */
export async function runWslGuestTreeKill(deps: {
  distro: string | null | undefined
  treeId: string | undefined
  timeoutMs?: number
  run?: WslGuestTreeKillRunner
}): Promise<void> {
  if (process.platform !== 'win32' || !deps.distro || !isUsablePtyTreeMarker(deps.treeId)) {
    return
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deps.treeId)) {
    console.warn('[daemon] WSL guest cleanup unverifiable: missing per-spawn UUID')
    return
  }
  const timeoutMs = deps.timeoutMs ?? WSL_GUEST_TREE_KILL_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= WSL_GUEST_STARTUP_RESERVE_MS) {
    console.warn('[daemon] WSL guest cleanup unverifiable: insufficient time budget')
    return
  }
  const deadline = performance.now() + timeoutMs
  const run = deps.run ?? runProcess
  const { distro, treeId } = deps
  const cwd = resolveWslInteropSpawnCwd()
  const program = resolveWslExecutablePath()
  if (!pathWin32.isAbsolute(program)) {
    console.warn('[daemon] WSL guest cleanup unverifiable: system wsl.exe unavailable')
    return
  }
  try {
    const x64 = resolveBundledGuestTreeKillArtifact('linux-x64')
    const arm64 = resolveBundledGuestTreeKillArtifact('linux-arm64')
    if (!x64 || !arm64) {
      console.warn('[daemon] WSL guest cleanup unverifiable: bundled helper unavailable')
      return
    }
    const probeBudgetMs = Math.min(deadline - performance.now(), WSL_RUNNING_PROBE_TIMEOUT_MS)
    if (probeBudgetMs <= 0) {
      throw new Error('WSL guest cleanup deadline elapsed before discovery')
    }
    // Cache coalescing can hand us a probe started before this cleanup request.
    const discovery = await beforeDeadline(
      (signal) =>
        run({
          program,
          args: ['--list', '--running', '--quiet'],
          env: rootCleanupEnv(),
          timeoutMs: probeBudgetMs,
          maxOutputBytes: 64 * 1024,
          cwd,
          signal
        }),
      probeBudgetMs
    )
    if (discovery.code !== 0 || discovery.timedOut || discovery.outputTruncated) {
      throw new Error('WSL running-distro discovery failed')
    }
    const running = filterUserWslDistros(parseWslDistros(discovery.stdout))
    if (!running.some((name) => name.toLowerCase() === distro.toLowerCase())) {
      return
    }
    const remainingMs = Math.floor(deadline - performance.now())
    if (remainingMs <= WSL_GUEST_STARTUP_RESERVE_MS) {
      throw new Error('WSL guest cleanup has no remaining execution budget')
    }
    // WSL has no atomic "exec only if running" option; this fresh check avoids known-stopped guests.
    const result = await beforeDeadline(
      (signal) =>
        run({
          program,
          args: buildWslGuestTreeKillArgs(
            distro,
            treeId,
            { x64, arm64 },
            remainingMs - WSL_GUEST_STARTUP_RESERVE_MS
          ),
          env: rootCleanupEnv(),
          input: buildWslGuestTreeKillInput({ x64, arm64 }),
          timeoutMs: remainingMs,
          maxOutputBytes: 64 * 1024,
          cwd,
          signal
        }),
      remainingMs
    )
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      console.warn('[daemon] WSL guest cleanup unverifiable', {
        code: result.code,
        timedOut: result.timedOut,
        reason:
          result.code === 3
            ? 'guest helper or kernel capability unavailable'
            : 'guest helper unavailable or incomplete'
      })
    }
  } catch {
    console.warn('[daemon] WSL guest cleanup unverifiable: discovery or execution failed')
  }
}
