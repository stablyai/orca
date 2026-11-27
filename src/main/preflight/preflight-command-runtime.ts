import {
  findRunnableLocalCommand,
  isCommandAvailable
} from '../ipc/preflight/preflight-command-exec'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import { resolveDefaultWslCliFallback } from '../git/command-runner/hosted-cli/default-wsl-cli-fallback'
import {
  WslDistroStoppedError,
  WslDistroUnverifiableError
} from '../wsl/filesystem/wsl-unc-access-gate'

/** A CLI verdict and, on the local path, the exact copy that produced it. */
export type CommandRuntime = {
  installed: boolean
  wslTarget?: WslPreflightTarget
  binary?: string
  /** The local PATH has no copy at all, as opposed to one that failed to run. */
  absent?: boolean
  refusedWslDistro?: string
}

export async function detectCommandRuntime(
  command: string,
  context?: PreflightRuntimeContext
): Promise<CommandRuntime> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return (await isCommandAvailable(command, wslTarget))
      ? { installed: true, wslTarget }
      : { installed: false }
  }
  // Pin auth to the copy that passed --version, so PATH cannot select the dead shim again.
  const probe = await findRunnableLocalCommand(command)
  if (probe.status === 'available') {
    return { installed: true, binary: probe.binary }
  }
  return probe.status === 'absent' ? { installed: false, absent: true } : { installed: false }
}

/** Same rule as glabExecFileAsync: a cwd-less call whose host glab is missing runs in the default distro. */
export async function detectDefaultWslGlab(): Promise<CommandRuntime> {
  try {
    const distro = (await resolveDefaultWslCliFallback('glab', ['--version']))?.wsl?.distro
    if (!distro) {
      return { installed: false }
    }
    const wslTarget = { distro }
    return (await isCommandAvailable('glab', wslTarget))
      ? { installed: true, wslTarget }
      : { installed: false }
  } catch (error) {
    // A stopped or unverifiable distro is not booted for a background read (E9).
    if (error instanceof WslDistroStoppedError || error instanceof WslDistroUnverifiableError) {
      return { installed: false, refusedWslDistro: error.distro }
    }
    return { installed: false }
  }
}

/** No workspace picked a runtime, so host CLIs run as cwd-less calls do: native, else the default distro. */
export function isWindowsHostDefault(context: PreflightRuntimeContext | undefined): boolean {
  return (
    process.platform === 'win32' &&
    !context?.projectRuntime &&
    !context?.wslDistro?.trim() &&
    !context?.wslDefault
  )
}
