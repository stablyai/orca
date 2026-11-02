import { resolveOrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import {
  remoteHostPlatformFromUnameProbe,
  UNAME_PLATFORM_PROBE_COMMAND,
  UNAME_PLATFORM_PROBE_MARKER
} from '../ssh/ssh-remote-platform-detection'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { LINUX_LIBC_FIRST_PROBE } from '../node-runtime/linux-libc-probe'
import type { WslDistroHolder } from './wsl-distro-holder'
import { refuseMissingWslDistro, WslDistroVersion1Error } from './wsl-distro-unsupported'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { createWslOrcadConnectStateReader } from './wsl-orcad-connect-state-snapshot'

const KERNEL_MARKER = '__ORCA_WSL_KERNEL__ '
const HOME_MARKER = '__ORCA_WSL_HOME__ '
const LIBC_MARKER = '__ORCA_WSL_LIBC__'
// The libc probe goes last: its output may span lines, so it takes everything after its marker.
export const WSL_HOST_FACTS_COMMAND = `printf '${KERNEL_MARKER}%s\\n${HOME_MARKER}%s\\n' "$(uname -r)" "$HOME"; ${UNAME_PLATFORM_PROBE_COMMAND}; printf '\\n%s\\n' '${LIBC_MARKER}'; ${LINUX_LIBC_FIRST_PROBE}`

type WslHostFacts = {
  kernel: string
  loginHome?: string
  platform?: RemoteHostPlatform
  firstLibcProbeOutput?: string
}

/**
 * Accepts only the exact shape the facts command prints; anything else (startup noise, a HOME
 * with a newline) returns null so the caller probes each fact on its own.
 */
export function readWslHostFacts(output: string): WslHostFacts | null {
  const lines = output.split('\n')
  const [kernelLine = '', homeLine = '', gap, platformLine = '', libcGap, libcMarker, ...libc] =
    lines
  if (
    !kernelLine.startsWith(KERNEL_MARKER) ||
    !homeLine.startsWith(HOME_MARKER) ||
    gap !== '' ||
    !platformLine.startsWith(UNAME_PLATFORM_PROBE_MARKER) ||
    libcGap !== '' ||
    libcMarker !== LIBC_MARKER
  ) {
    return null
  }
  const loginHome = homeLine.slice(HOME_MARKER.length)
  return {
    kernel: kernelLine.slice(KERNEL_MARKER.length).trim(),
    ...(loginHome.trim() ? { loginHome } : {}),
    ...withPlatform(remoteHostPlatformFromUnameProbe(`\n${platformLine}`)),
    firstLibcProbeOutput: libc.join('\n')
  }
}

function withPlatform(platform: RemoteHostPlatform | null): { platform?: RemoteHostPlatform } {
  return platform ? { platform } : {}
}

/** WSL 1 runs no Linux kernel, so the pinned Node and its pty cannot run there. */
export function isWsl1KernelRelease(release: string): boolean {
  return /^\d+\.\d+\.\d+-\d+-Microsoft$/.test(release.trim())
}

/**
 * Refuses WSL 1, then acquires the holder alongside the read-only context probes: the kernel probe
 * already started the distro, so the holder spawns nothing extra, and it is held before the caller
 * may launch orcad (recovery included) or WSL could idle-stop its distro.
 */
export async function holdWslDistroWithContext(
  name: string,
  target: WslOrcadHostTarget,
  conn: OrcadHostTransport,
  holder: WslDistroHolder,
  signal: AbortSignal | undefined
) {
  // One exec for the kernel, the login home and the platform the context would probe one by one.
  const facts = readWslHostFacts(
    await execCommand(conn, WSL_HOST_FACTS_COMMAND, { signal }).catch(refuseMissingWslDistro(name))
  ) ??
    // Unrecognized output proves nothing: read the kernel alone, as before, and let the context probe.
    { kernel: await execCommand(conn, 'uname -r', { signal }).catch(refuseMissingWslDistro(name)) }
  if (isWsl1KernelRelease(facts.kernel)) {
    throw new WslDistroVersion1Error(name)
  }
  // Once the hold fails, stop the probes: after dispose they fall back to fresh wsl.exe execs,
  // which would boot a distro that just went away (E9).
  const probes = new AbortController()
  if (signal?.aborted) {
    probes.abort(signal.reason)
  }
  const stopProbes = (): void => probes.abort(signal?.reason)
  signal?.addEventListener('abort', stopProbes, { once: true })
  const connectState = createWslOrcadConnectStateReader()
  try {
    const [held, context] = await Promise.all([
      holder.ensureHeld(name).catch((error: unknown) => {
        probes.abort(error)
        throw error
      }),
      resolveOrcadRemoteContext(target, conn, probes.signal, facts.platform, {
        loginHome: facts.loginHome,
        readActivationRecord: connectState.readActivationRecord,
        // Only with a proven platform: the libc answer belongs to the same host shape.
        ...(facts.platform ? { firstLibcProbeOutput: facts.firstLibcProbeOutput } : {})
      })
    ])
    return { held, context, connectState: connectState.snapshot() }
  } catch (error) {
    probes.abort(error)
    throw error
  } finally {
    signal?.removeEventListener('abort', stopProbes)
  }
}
