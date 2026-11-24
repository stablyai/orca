import type { ResolvedCommand } from './wsl-command-resolution'

/** The `git.runs_in` span attribute: which Git a call ran, `host` or `wsl:<distro>`. */
export function gitRunsIn(resolved: Pick<ResolvedCommand, 'wsl'>): string {
  return resolved.wsl ? `wsl:${resolved.wsl.distro}` : 'host'
}
