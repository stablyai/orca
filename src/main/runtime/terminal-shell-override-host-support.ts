import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { parseWslUncPath } from '../../shared/wsl-paths'

/** Refuse shell overrides the execution host cannot honor; silently substituting a shell also misquotes its startup command. */
export function terminalShellOverrideRefusal(args: {
  shellOverride: string | undefined
  connectionId: string | null
  platform: NodeJS.Platform
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  /** The cwd the PTY will spawn in, resolved the same way the spawn lanes resolve it. */
  cwd: string
  workspacePath: string
}): Error | null {
  if (!args.shellOverride) {
    return null
  }
  if (args.connectionId) {
    // The shell runs on the SSH host, whose platform and installed shells this runtime cannot see.
    return new Error(
      `This workspace runs its terminals over SSH, and Orca cannot apply --shell ${args.shellOverride} there. No terminal was created. Omit --shell, or create the terminal on the execution host itself.`
    )
  }
  if (args.platform !== 'win32') {
    return new Error(
      `--shell ${args.shellOverride} names a Windows shell, and this execution host is ${args.platform}, which spawns the user's login shell. No terminal was created; omit --shell.`
    )
  }
  // The path first: no runtime setting can move a `\\wsl$` path out of WSL, so only it names a fix.
  return (
    wslUncPathShellConflict(args.shellOverride, args.cwd, args.workspacePath) ??
    projectRuntimeShellConflict(args.shellOverride, args.projectRuntime)
  )
}

/** Project runtime chooses the machine and can rewrite conflicting shell picks; refuse before startup arguments are quoted for a different shell. */
function projectRuntimeShellConflict(
  shellOverride: string,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): Error | null {
  if (projectRuntime?.status !== 'resolved') {
    return null
  }
  const runsInWsl = projectRuntime.runtime.kind === 'wsl'
  if (runsInWsl === isWslShellName(shellOverride)) {
    return null
  }
  // A workspace with no saved runtime of its own follows the default, so name that.
  const byDefault = projectRuntime.runtime.reason === 'global-default'
  const runs = `${byDefault ? 'This workspace runs' : "This workspace's project runs"} its terminals ${runsInWsl ? 'in WSL' : 'on the Windows host'}${byDefault ? ', the default in Settings > Project Runtime' : ''}`
  const change = byDefault ? 'that default' : "the project's execution runtime"
  return new Error(
    runsInWsl
      ? `${runs}, so --shell ${shellOverride} cannot be applied. No terminal was created. Use --shell wsl.exe, or change ${change}.`
      : `${runs}, so --shell ${shellOverride} cannot be applied. No terminal was created. Change ${change} to WSL, or pass a Windows shell.`
  )
}

/** WSL UNC cwd/workspace paths force their distro via resolveWslSessionContext, including folder workspaces without project runtime; refuse a conflicting explicit shell. */
function wslUncPathShellConflict(
  shellOverride: string,
  cwd: string,
  workspacePath: string
): Error | null {
  if (isWslShellName(shellOverride)) {
    return null
  }
  const wslPath = [cwd, workspacePath].find((path) => parseWslUncPath(path) !== null)
  if (wslPath === undefined) {
    return null
  }
  return new Error(
    `This terminal would run inside WSL because ${wslPath} lives in a WSL distro, so --shell ${shellOverride} cannot be applied. No terminal was created. Use --shell wsl.exe, or omit --shell.`
  )
}
