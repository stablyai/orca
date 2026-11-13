import { createAbortError } from '../process-capture/abort-error'
import type { GitExecOptions } from '../git-exec-options'
import type { ResolvedCommand } from './wsl-command-resolution'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/git-admission-tier-params'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting,
  usesHostGitForWslLinkedWorktree
} from './wsl-linked-worktree-git-routing'
import { pendingWslWindowsCheckoutGitConfig } from './wsl-windows-checkout-git-probe'
import { wslDistroForCommand } from '../../../../shared/wsl-paths'
import {
  captureWslAutomountSnapshot,
  assertWslAutomountSnapshotCurrent,
  type WslAutomountSnapshot,
  ensureWslAutomountRoot,
  peekWslAutomountRoot
} from '../../../wsl/filesystem/wsl-automount-root'
import { isWindowsDrivePath } from '../../../wsl/filesystem/wsl-drive-paths'
import { noteWslDistroLaunched } from '../../../wsl/discovery/wsl-background-distro-gate'

export type GitExecutionContext = Readonly<
  { kind: 'host' } | { kind: 'wsl'; paths: WslAutomountSnapshot }
>

export function captureGitExecutionContext(options: {
  cwd: string
  wslDistro?: string
  hostGit?: true
}): GitExecutionContext {
  const distro = wslDistroForCommand(options.cwd, options.wslDistro)
  return distro && !usesHostGitForWslLinkedWorktree(options.cwd, options.wslDistro)
    ? { kind: 'wsl', paths: captureWslAutomountSnapshot(distro) }
    : { kind: 'host' }
}

/** Keep checkout ownership fixed while validating only the values used by this launch. */
export function assertPreparedGitCommand(
  command: ResolvedCommand,
  args: readonly string[],
  options: GitExecOptions
): void {
  options.signal?.throwIfAborted()
  options.admissionSignal?.throwIfAborted()
  let context = command.executionContext
  const driveInputs = isWindowsDrivePath(options.cwd) || args.some(isWindowsDrivePath)
  if (context?.kind === 'wsl') {
    noteWslDistroLaunched(context.paths.distro)
    if (!driveInputs) {
      context = { kind: 'wsl', paths: captureWslAutomountSnapshot(context.paths.distro) }
      command.executionContext = context
    }
  }
  if (options.canStart?.(context) === false) {
    throw createAbortError()
  }
  if (context?.kind === 'wsl' && driveInputs) {
    assertWslAutomountSnapshotCurrent(context.paths)
  }
}

export function gitResultWithExecutionContext<T extends object>(
  result: T,
  context?: GitExecutionContext
): T & { executionContext?: GitExecutionContext } {
  return Object.defineProperty(result, 'executionContext', { value: context })
}

/** Settle guest paths and checkout ownership before synchronous command resolution. */
export function pendingWslGitPathPreparation(
  args: readonly string[],
  options: {
    cwd: string
    wslDistro?: string
    hostGit?: true
    signal?: AbortSignal
    admissionTier?: GitAdmissionTier
  }
): Promise<GitExecutionContext> | null {
  const distro = wslDistroForCommand(options.cwd, options.wslDistro)
  if (!distro) {
    return null
  }
  const driveCheckout = isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)
  const needsRoot = driveCheckout || args.some(isWindowsDrivePath)
  if (!driveCheckout && needsRoot) {
    noteWslDistroLaunched(distro)
  }
  if (!driveCheckout && (!needsRoot || peekWslAutomountRoot(distro) !== null)) {
    return null
  }
  return (async () => {
    options.signal?.throwIfAborted()
    if (driveCheckout) {
      const host = await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro, {
        signal: options.signal
      })
      if (host) {
        return { kind: 'host' }
      }
    }
    noteWslDistroLaunched(distro)
    if (peekWslAutomountRoot(distro) === null) {
      await ensureWslAutomountRoot(distro, options.signal)
    }
    if (driveCheckout) {
      await pendingWslWindowsCheckoutGitConfig(args, options)
    }
    return { kind: 'wsl', paths: captureWslAutomountSnapshot(distro) }
  })()
}
