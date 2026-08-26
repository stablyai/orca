import { parseWslPath } from '../../wsl'
import { isWslDirectGitReadCommand } from '../wsl-direct-git-read-commands'
import {
  disableWslGitReadEnvironment,
  getWslGitReadEnvironment,
  invalidateWslGitReadEnvironment,
  peekWslGitReadEnvironment
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
  if (!forceLoginShell && shouldAttemptWslDirectGit(args, options)) {
    const distro = wslDistroForCommand(options.cwd, options.wslDistro)
    const environment = distro ? peekWslGitReadEnvironment(distro) : undefined
    if (environment) {
      return resolveCommand('git', args, options.cwd, options.wslDistro, {
        wslGitReadEnvironment: environment,
        env: options.env,
        terminationBarrier: options.terminationBarrier
      })
    }
    if (distro) {
      void getWslGitReadEnvironment(distro)
    }
  }
  return resolveGitCommandWithoutProbe(args, options, captureLoginShellOutput)
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
    ) &&
    options.wslDistro
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
