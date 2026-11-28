import { wslDistroForCommand } from '../../../../shared/file-access/wsl-paths'
import { routeLocalGitOptions } from './local-git-runtime-route'
import type { ResolvedCommand } from './wsl-command-resolution'
import { usesHostGitForWslLinkedWorktree } from './wsl-linked-worktree-git-routing'

/** The `git.runs_in` span attribute: which Git a call ran, `host` or `wsl:<distro>`. */
export function gitRunsIn(resolved: Pick<ResolvedCommand, 'wsl'>): string {
  return resolved.wsl ? `wsl:${resolved.wsl.distro}` : 'host'
}

/**
 * Which Git a local call would run right now, by the runner's own precedence: project runtime
 * router, host-Git linked-worktree fallback, then a UNC cwd's distro over the override. Pure, so
 * caches can key on the route without resolveGitCommand's launch/probe side effects. Distro names
 * are case-insensitive in WSL, so they are lowercased.
 */
export function predictLocalGitRunsIn(cwd: string, wslDistro?: string): string {
  if (process.platform !== 'win32') {
    return 'host'
  }
  const routed = routeLocalGitOptions({ cwd, ...(wslDistro ? { wslDistro } : {}) })
  if (usesHostGitForWslLinkedWorktree(cwd, routed.wslDistro)) {
    return 'host'
  }
  const distro = wslDistroForCommand(cwd, routed.wslDistro)
  return distro ? `wsl:${distro.toLowerCase()}` : 'host'
}
