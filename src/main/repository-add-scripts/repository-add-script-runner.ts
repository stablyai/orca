import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessTerminationBarrier } from '@orca/process-host/process-spec'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { parseRoutableExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type {
  RepositoryAddScriptExecutionResult,
  RepositoryAddScriptTarget
} from '../../shared/repository-add-script-types'
import { nativeWindowsPathToPosixShellPath } from '../../shared/setup-runner-command'
import { isShebangLine, scriptDeclaresPosixShell } from '../../shared/setup-script-shebang'
import { resolveGitBashPath } from '../git-bash'
import { HOOK_TIMEOUT } from '../hooks'
import { buildPosixRunnerScript, buildWindowsRunnerScript } from '../setup-runner-script-text'
import { createWslProcessGroupTermination } from '../git/wsl-process-group-termination'
import { runWslProcess, type WslGuestTermination } from '../wsl/wsl-runner'
import { buildNativeEnv, buildWslGuestEnv } from './repository-add-script-run-env'
import type {
  RepositoryAddScriptAuthorizationCheck,
  RepositoryAddScriptRun
} from './repository-add-script-service'
import { summarizeSpawn, trackTermination } from './repository-add-script-stop-verdict'
import {
  isSameRepositoryAddScriptTarget,
  resolveRepositoryAddScriptTarget
} from './repository-add-script-target'

const MAX_CAPTURE_BYTES = 1024 * 1024
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux', 'win32']

export function isRepositoryAddScriptPlatformSupported(platform: NodeJS.Platform): boolean {
  return SUPPORTED_PLATFORMS.includes(platform)
}

export type RepositoryAddScriptRunnerDependencies = {
  /** The host identity this process executes for; a run must be owned by exactly this host. */
  getExecutorHostId: () => ExecutionHostId
  /** Project runtime of the run's repo; it must place the run exactly where it was approved. */
  getRuntime: (run: RepositoryAddScriptRun) => ProjectExecutionRuntimeResolution | undefined
  platform?: NodeJS.Platform
  runProcess?: typeof runProcess
  runWslProcess?: typeof runWslProcess
  resolveGitBashPath?: () => string | null
  createTempRoot?: () => string
  createGuestTermination?: (distro: string) => WslGuestTermination
  treeTermination?: ProcessTerminationBarrier
}

function assertSupportedInterpreter(script: string): void {
  if (isShebangLine(script.split('\n', 1)[0] ?? '') && !scriptDeclaresPosixShell(script)) {
    throw new Error('Repository add script declares an unsupported interpreter.')
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('Repository add script was stopped before it started.')
  }
}

/**
 * Runs an authorized add script on this computer only. Callers must have already established that
 * the run's owner is this host; anything else, or any unresolvable runtime, fails closed.
 */
export function createRepositoryAddScriptRunner(
  dependencies: RepositoryAddScriptRunnerDependencies
): (
  run: RepositoryAddScriptRun,
  isAuthorized: RepositoryAddScriptAuthorizationCheck,
  signal?: AbortSignal
) => Promise<RepositoryAddScriptExecutionResult> {
  const platform = dependencies.platform ?? process.platform
  const spawnProcess = dependencies.runProcess ?? runProcess
  const spawnWsl = dependencies.runWslProcess ?? runWslProcess
  const findGitBash = dependencies.resolveGitBashPath ?? (() => resolveGitBashPath({ platform }))
  const createTempRoot = dependencies.createTempRoot ?? tmpdir
  const treeTermination = dependencies.treeTermination ?? {
    signal: signalProcessTree,
    force: forceTerminateProcessTree
  }
  const createGuestTermination =
    dependencies.createGuestTermination ??
    ((distro: string) => createWslProcessGroupTermination(distro, { requireIsolation: true }))

  // Re-resolved at entry and in the spawn's tick; the approved target is never rewritten.
  function checkTarget(run: RepositoryAddScriptRun): RepositoryAddScriptTarget {
    // Exact identity, never rewritten: a runtime owner runs only on that runtime's own process.
    const executor = dependencies.getExecutorHostId()
    if (parseRoutableExecutionHostId(executor)?.id !== executor || run.hostId !== executor) {
      throw new Error('Repository add script owner is not this executor.')
    }
    if (!isRepositoryAddScriptPlatformSupported(platform) || run.script.trim() === '') {
      throw new Error('Repository add script cannot run here.')
    }
    const runtime = dependencies.getRuntime(run)
    if (runtime?.status === 'repair-required') {
      throw new Error('Repository add script runtime needs repair.')
    }
    const target = resolveRepositoryAddScriptTarget(run.path, runtime, platform)
    if (!target) {
      throw new Error('Repository add script has no usable execution target.')
    }
    if (!isSameRepositoryAddScriptTarget(target, run.target)) {
      throw new Error('Repository add script execution target changed.')
    }
    return target
  }

  return async (run, isAuthorized, signal) => {
    assertNotAborted(signal)
    const target = checkTarget(run)
    assertSupportedInterpreter(run.script)
    // The final guard runs in the spawn's tick; nothing can invalidate it afterwards.
    const guard = (): true => {
      const verdict: unknown = isAuthorized()
      if (verdict !== true) {
        // A rejected promise from a misused async check must not become unhandled.
        if (verdict instanceof Promise) {
          verdict.catch(() => undefined)
        }
        throw new Error('Repository add script approval is no longer current.')
      }
      assertNotAborted(signal)
      checkTarget(run)
      return true
    }
    guard()

    if (target.kind === 'wsl') {
      const guest = trackTermination(createGuestTermination(target.distro), platform)
      return summarizeSpawn(
        spawnWsl({
          distro: target.distro,
          loginPath: 'preferred',
          script: buildPosixRunnerScript(run.script),
          shell: 'bash',
          cwd: target.cwd,
          env: buildWslGuestEnv(run),
          timeoutMs: HOOK_TIMEOUT,
          maxOutputBytes: MAX_CAPTURE_BYTES,
          guestTermination: guest.barrier,
          signal,
          beforeSpawn: guard
        }),
        guest,
        signal
      )
    }

    // A POSIX shebang on Windows is the only way into bash; otherwise cmd regardless of terminal shell.
    const windowsBash =
      platform === 'win32' && scriptDeclaresPosixShell(run.script) ? findGitBash() : null
    if (platform === 'win32' && scriptDeclaresPosixShell(run.script) && !windowsBash) {
      throw new Error('Repository add script needs Git Bash, which was not found.')
    }
    const useCmd = platform === 'win32' && !windowsBash
    const directory = await mkdtemp(join(createTempRoot(), 'orca-add-script-'))
    try {
      const file = join(directory, useCmd ? 'runner.cmd' : 'runner.sh')
      await writeFile(
        file,
        useCmd ? buildWindowsRunnerScript(run.script) : buildPosixRunnerScript(run.script),
        {
          encoding: 'utf-8',
          mode: 0o600
        }
      )
      const program = useCmd ? file : (windowsBash ?? '/bin/bash')
      const args = useCmd ? [] : [windowsBash ? nativeWindowsPathToPosixShellPath(file) : file]
      guard()
      const tree = trackTermination(treeTermination, platform)
      return await summarizeSpawn(
        spawnProcess({
          program,
          args,
          cwd: target.cwd,
          env: buildNativeEnv(run, platform),
          timeoutMs: HOOK_TIMEOUT,
          maxOutputBytes: MAX_CAPTURE_BYTES,
          terminationBarrier: tree.barrier,
          signal
        }),
        tree,
        signal
      )
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
