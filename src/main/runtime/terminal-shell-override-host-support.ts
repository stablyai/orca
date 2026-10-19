import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { parseWslUncPath } from '../../shared/wsl-paths'

/**
 * Whether the host about to spawn a terminal can honour a requested Windows shell.
 *
 * The whole point of `--shell` is that the caller stops having to guess which shell it got. A host
 * that cannot apply the pick must say so: silently spawning its default shell returns a healthy
 * terminal running something else, which is the exact failure `--shell` exists to remove.
 */
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

/**
 * The project's execution runtime decides which MACHINE the shell runs on, so it outranks a
 * per-terminal pick — and `resolveLocalWindowsTerminalRuntimeOptions` enforces that by rewriting
 * the value: a WSL project forces `wsl.exe`, and a Windows-host project discards a WSL name in
 * favour of the host shell. Either rewrite hands back a terminal running something the caller did
 * not ask for, and it also splits the startup-command quoting from the shell that receives it
 * (POSIX args typed into cmd, or cmd args typed into a WSL shell). Refusing the contradiction is
 * the only answer that keeps the request and the terminal describing the same thing.
 */
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

/**
 * A `\\wsl$\<distro>\...` path only exists inside that distro, so the providers force `wsl.exe`
 * for it whatever shell was requested (`resolveWslSessionContext` keys off the cwd, then the
 * workspace path behind the session). That rewrite is right for the global shell setting and
 * wrong for `--shell`, which promised the caller the shell it named. This is the only check that
 * still fires for a folder workspace, which has no project runtime to disagree with.
 */
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
