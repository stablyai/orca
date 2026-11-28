import { blockedWslDistroForExec } from '../../../wsl/discovery/wsl-background-exec-gate'
import {
  runAsWslUserAct,
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import {
  defaultWslCliDistro,
  defaultWslCliDistroAsync,
  resolveCommand,
  type ResolvedCommand
} from '../host-routing/wsl-command-resolution'

/**
 * The distro a cwd-less gh/glab call falls back to when its host CLI is missing. Background work must
 * not boot a stopped distro (E9), so a stopped or unverifiable one refuses with its own error rather
 * than "not installed"; inside a user act for that distro it may still start it.
 */
async function admittedDefaultWslCliDistro(): Promise<string | null> {
  const distro = await defaultWslCliDistroAsync()
  // Gate before resolveCommand: building a wsl.exe command notes the distro as launched (woken).
  const blocked = distro ? await blockedWslDistroForExec(distro) : null
  if (blocked?.state === 'stopped') {
    // A background retry would refuse again; only a terminal (a user act) starts it.
    throw new WslDistroStoppedError(blocked.distro, { retryStartsIt: false })
  }
  if (blocked) {
    throw new WslDistroUnverifiableError(blocked.distro)
  }
  return distro
}

/** The default distro's gh/glab for a cwd-less call whose host CLI is missing. */
export async function resolveDefaultWslCliFallback(
  command: 'gh' | 'glab',
  args: string[]
): Promise<ResolvedCommand | null> {
  const distro = await admittedDefaultWslCliDistro()
  return distro ? resolveCommand(command, args, undefined, distro) : null
}

/**
 * Runs a user's click (star, auth diagnosis, a project-board action) as a user act on the distro a
 * cwd-less gh/glab call would fall back to, so it may start that distro when it is stopped.
 */
export function runAsDefaultWslCliUserAct<T>(act: () => Promise<T>): Promise<T> {
  return runAsWslUserAct(process.platform === 'win32' ? defaultWslCliDistro() : null, act)
}
