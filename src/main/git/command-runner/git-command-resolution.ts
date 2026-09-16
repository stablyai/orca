import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { parseWslPath } from '../../wsl'
import { isWslDirectGitReadCommand } from '../wsl-direct-git-read-commands'
import {
  disableWslGitReadEnvironment,
  getWslGitReadEnvironment,
  invalidateWslGitReadEnvironment,
  isWslGitReadEnvironmentSettled,
  peekWslGitReadEnvironment,
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS
} from '../wsl-git-read-environment'
import { usesHostGitForWslLinkedWorktree } from '../wsl-linked-worktree-git-routing'
import { resolveCommand, type ResolvedCommand } from './wsl-command-resolution'
import type { GitExecOptions } from './git-exec-options'

function wslDistroForCommand(cwd: string | undefined, override?: string): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  return (cwd ? parseWslPath(cwd)?.distro : undefined) ?? override ?? null
}

export function resolveGitCommand(
  args: string[],
  options: GitExecOptions,
  forceLoginShell = false,
  captureLoginShellOutput = false
): ResolvedCommand {
  if (usesHostGitForWslLinkedWorktree(options.cwd, options.wslDistro)) {
    // Why: WSL Git resolves a Windows-authored linked-worktree pointer relative to cwd.
    return { binary: 'git', args, cwd: options.cwd, wsl: null, wslMode: null }
  }
  const distro = directWslGitReadDistro(args, options, forceLoginShell)
  if (distro) {
    const environment = peekWslGitReadEnvironment(distro)
    if (environment) {
      return resolveCommand('git', args, options.cwd, distro, {
        wslGitReadEnvironment: environment,
        env: options.env,
        terminationBarrier: options.terminationBarrier
      })
    }
    void getWslGitReadEnvironment(distro)
  }
  return resolveGitCommandWithoutProbe(args, options, captureLoginShellOutput)
}

/**
 * The distro this command could run shell-free in, or null when it can't.
 *
 * Why cwd counts: a `\\wsl.localhost\<distro>\...` worktree names its distro in
 * the path, so requiring the caller to have resolved a WSL project runtime first
 * left every diff read on the login shell — one rc run per `git show`.
 */
function directWslGitReadDistro(
  args: string[],
  options: GitExecOptions,
  forceLoginShell: boolean
): string | null {
  if (forceLoginShell || !shouldAttemptWslDirectGit(args, options)) {
    return null
  }
  return wslDistroForCommand(options.cwd, options.wslDistro)
}

function shouldAttemptWslDirectGit(args: string[], options: GitExecOptions): boolean {
  return Boolean(
    process.platform === 'win32' &&
    // Why either: callers can still opt in explicitly, but a plain read no
    // longer has to -- it needs nothing the login shell provides, and routing
    // it through one is what exposes callers to the shell's rc output.
    (options.preferWslDirectGit || isWslDirectGitReadCommand(args)) &&
    !options.useConfiguredSshCommandForNetwork &&
    !Object.entries(options.env ?? {}).some(
      ([key, value]) =>
        key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS' && value !== process.env[key]
    )
  )
}

/**
 * Give a read the chance to take the shell-free route instead of silently
 * falling back while the probe is still resolving.
 *
 * The probe is one `wsl.exe` call, shared per distro and reused by every later
 * command, so waiting costs at most once. Bounded because a cold or wedged
 * distro must not hold a read behind it — past the bound the login-shell route
 * runs exactly as it did before.
 */
export function pendingWslDirectGitReadEnvironment(
  args: string[],
  options: GitExecOptions
): Promise<unknown> | null {
  // Why null rather than a resolved promise: every non-WSL git call goes through here, and
  // awaiting even an already-settled promise would push the spawn into a later microtask.
  // A settled probe — including a distro whose direct route was permanently disabled — has
  // nothing left to wait for, and neither does a read that is already aborted.
  const distro = directWslGitReadDistro(args, options, false)
  if (!distro || isWslGitReadEnvironmentSettled(distro) || options.signal?.aborted) {
    return null
  }
  // withTimeout also absorbs rejection, so a probe failure can never become a read failure.
  return withTimeout(
    waitForPromiseWithSignal(getWslGitReadEnvironment(distro), options.signal),
    WSL_GIT_READ_ENVIRONMENT_WAIT_MS,
    null
  )
}

export function resolveGitCommandWithoutProbe(
  args: string[],
  options: GitExecOptions,
  captureLoginShellOutput = false
): ResolvedCommand {
  return resolveCommand('git', args, options.cwd, options.wslDistro, {
    useWslLoginShell: Boolean(options.wslDistro),
    captureLoginShellOutput,
    terminationBarrier: options.terminationBarrier
  })
}

function isDirectWslGitNotFound(error: unknown, resolved: ResolvedCommand): boolean {
  if (resolved.wslMode !== 'direct-git' || !error || typeof error !== 'object') {
    return false
  }
  const { code, stderr } = error as { code?: unknown; stderr?: unknown }
  const message = typeof stderr === 'string' ? stderr : String(stderr ?? '')
  return code === 127 && (message.includes('not found') || message.includes('No such file'))
}

export function directWslGitExitCode(error: unknown, resolved: ResolvedCommand): number | null {
  if (resolved.wslMode !== 'direct-git' || !error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}

/**
 * Exit 1 with nothing on stderr is Git answering "no" (a missing ref under
 * `show-ref --verify --quiet`, no differences under `diff --quiet`), not a
 * broken environment. `wsl.exe` always explains its own launch failures, so
 * this cannot mask a dead distro. Retrying such an exit through the user's
 * interactive login shell doubles the spawn count and runs the distro's rc
 * files for a result the direct route already produced correctly.
 */
export function isQuietGitControlFlowExit(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const record = error as Record<string, unknown>
  if (record.code !== 1) {
    return false
  }
  const stderr = record.stderr
  return stderr !== undefined && stderr !== null && String(stderr).trim().length === 0
}

export function invalidateMissingDirectWslGit(error: unknown, resolved: ResolvedCommand): boolean {
  const isMissing = isDirectWslGitNotFound(error, resolved)
  if (isMissing && resolved.wsl) {
    invalidateWslGitReadEnvironment(resolved.wsl.distro)
  }
  return isMissing
}

export function disableDirectWslGitAfterSuccessfulFallback(
  wasMissing: boolean,
  resolved: ResolvedCommand
): void {
  if (!wasMissing && resolved.wsl) {
    disableWslGitReadEnvironment(resolved.wsl.distro)
  }
}
