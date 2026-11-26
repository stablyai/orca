import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { wslAwareSpawn } from '../git/command-runner/host-routing/wsl-aware-spawn'
import { resolveCommand } from '../git/command-runner/host-routing/wsl-command-resolution'
import { recordSubprocessSpawn } from '../diagnostics/main-thread-churn-probe'
import {
  canSpawnOnWorkerThread,
  spawnProcessOnWorkerThread
} from '../worker-thread-child-process/worker-thread-child-process'
import { bundledRipgrepCommand, bundledRipgrepWslSpawnOptions } from './bundled-ripgrep-path'
import { RIPGREP_MISSING_CWD_EXIT_CODE } from '../../shared/ripgrep/ripgrep-process-availability'

type WslAwareSpawnOptions = Parameters<typeof wslAwareSpawn>[2]

export type BundledRipgrepSpawnOptions = Omit<
  WslAwareSpawnOptions,
  'wslDistro' | 'wslShellCommand' | 'useWslLoginShell'
> & {
  cwd: string
  /** Distro whose git options own this workspace; routes the spawn through wsl.exe. */
  wslDistro?: string
  /** Set when rg runs inside WSL, so it emits Linux paths the caller translates back. */
  wslDistroForOutput?: string
}

/** Centralize bundled rg spawning; bare names let Windows execute binaries from the workspace before PATH. */
export function spawnBundledRipgrep(
  args: string[],
  options: BundledRipgrepSpawnOptions
): ReturnType<typeof wslAwareSpawn> {
  const { wslDistro, wslDistroForOutput, ...spawnOptions } = options
  const command = bundledRipgrepCommand({ wsl: Boolean(wslDistroForOutput) })
  if (!wslDistro && !wslDistroForOutput) {
    const workerChild = spawnNativeRipgrepOnWorkerThread(command, args, spawnOptions)
    if (workerChild) {
      return workerChild
    }
  }
  return wslAwareSpawn(command, args, {
    ...spawnOptions,
    ...(wslDistro ? { wslDistro } : {}),
    // Shell cd failure is exit 1 like rg no-match; WSL needs a distinct cwd verdict.
    ...(wslDistro || wslDistroForOutput
      ? { cwdFailureExitCode: RIPGREP_MISSING_CWD_EXIT_CODE }
      : {}),
    ...(wslDistroForOutput ? bundledRipgrepWslSpawnOptions(command) : {})
  })
}

function hasPipedOutputOnly(stdio: SpawnOptions['stdio']): boolean {
  return (
    Array.isArray(stdio) &&
    stdio.length === 3 &&
    (stdio[0] === 'ignore' || stdio[0] === 'pipe') &&
    stdio[1] === 'pipe' &&
    stdio[2] === 'pipe'
  )
}

/**
 * Why: Windows security software that inspects process creation can hold CreateProcessW, and so main's
 * event loop, for seconds per listing (#20497). WSL-routed rg keeps its inline path.
 */
function spawnNativeRipgrepOnWorkerThread(
  command: string,
  args: string[],
  options: Omit<BundledRipgrepSpawnOptions, 'wslDistro' | 'wslDistroForOutput'>
): ChildProcess | null {
  if (
    process.platform !== 'win32' ||
    !hasPipedOutputOnly(options.stdio) ||
    // The worker child has no abort signal or timeout of its own; those launches keep Node's handling.
    options.signal ||
    options.timeout ||
    !canSpawnOnWorkerThread()
  ) {
    return null
  }
  const resolved = resolveCommand(command, args, options.cwd)
  if (resolved.wsl) {
    return null
  }
  const spawnStartedAt = performance.now()
  const child = spawnProcessOnWorkerThread({
    program: resolved.binary,
    args: resolved.args,
    cwd: resolved.cwd,
    env: { ...(options.env ?? process.env) }
  })
  // Worker children always get a stdin pipe; close it when the caller asked for 'ignore'.
  if (Array.isArray(options.stdio) && options.stdio[0] === 'ignore') {
    child.stdin.end()
  }
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in implements every ChildProcess member rg callers use (pid, exitCode, signalCode, kill, on/once/off, stdout/stderr data, setEncoding, resume); bundled-ripgrep-worker-spawn.test.ts drives a real caller through it.
  return child as unknown as ChildProcess
}
