import { blockedWslDistroForExec } from '../../wsl/wsl-background-exec-gate'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../../wsl/wsl-unc-access-gate'
import { resolveDefaultWslCli, type ResolvedCommand } from './wsl-command-resolution'

/**
 * The default distro's gh/glab for a cwd-less call whose host CLI is missing. Background work must
 * not boot a stopped distro (E9), so a stopped or unverifiable one refuses with its own error rather
 * than "not installed"; inside a user act for that distro it may still start it.
 */
export async function resolveDefaultWslCliFallback(
  command: 'gh' | 'glab',
  args: string[]
): Promise<ResolvedCommand | null> {
  const resolved = resolveDefaultWslCli(command, args)
  const distro = resolved?.wsl?.distro
  const blocked = distro ? await blockedWslDistroForExec(distro) : null
  if (blocked?.state === 'stopped') {
    // A background retry would refuse again; only a terminal (a user act) starts it.
    throw new WslDistroStoppedError(blocked.distro, { retryStartsIt: false })
  }
  if (blocked) {
    throw new WslDistroUnverifiableError(blocked.distro)
  }
  return resolved
}
