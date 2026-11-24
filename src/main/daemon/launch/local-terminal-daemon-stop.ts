import { daemonRuntimeDirFor } from '../endpoint/publication/daemon-runtime-dir'
import { macDaemonJobLabel } from '../executable-host/macos/macos-daemon-job-label'
import { releaseMacDaemonJob } from '../executable-host/macos/macos-daemon-job-state'
import { listMacDaemonJobVersions } from '../executable-host/macos/macos-retired-daemon-jobs'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../protocol/daemon-protocol-version'
import { listLiveDaemonProtocols } from './daemon-generation-liveness'
import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'

const KNOWN_PROTOCOLS: readonly number[] = [PROTOCOL_VERSION, ...PREVIOUS_DAEMON_PROTOCOL_VERSIONS]
const MAC_JOB_EXIT_WAIT_MS = 5_000

/** True unless every daemon generation of this profile is proven gone; an unreadable one counts as live. */
export async function isLocalTerminalDaemonLive(userDataPath: string): Promise<boolean> {
  const live = await listLiveDaemonProtocols(daemonRuntimeDirFor(userDataPath), KNOWN_PROTOCOLS)
  return live === null || live.length > 0
}

// The job is already stopped once its daemon exits (KeepAlive is off); boot it out so no label is left.
async function bootOutMacDaemonJobs(userDataPath: string): Promise<void> {
  const versions = await listMacDaemonJobVersions(userDataPath).catch(() => [])
  for (const version of versions) {
    const service = `gui/${process.getuid?.()}/${macDaemonJobLabel(userDataPath, version)}`
    await releaseMacDaemonJob(service, Date.now() + MAC_JOB_EXIT_WAIT_MS).catch(() => false)
  }
}

/**
 * Ends every terminal daemon generation of this profile and the terminals it runs, through each
 * daemon's own shutdown request (verified pid kill when it cannot answer). Throws unless none is left.
 */
export async function stopLocalTerminalDaemons(userDataPath: string): Promise<void> {
  const runtimeDir = daemonRuntimeDirFor(userDataPath)
  const live = (await listLiveDaemonProtocols(runtimeDir, KNOWN_PROTOCOLS)) ?? KNOWN_PROTOCOLS
  let firstError: unknown = null
  for (const protocolVersion of live) {
    await cleanupDaemonForProtocol(runtimeDir, protocolVersion).catch((error: unknown) => {
      firstError ??= error
    })
  }
  if (process.platform === 'darwin') {
    await bootOutMacDaemonJobs(userDataPath)
  }
  const left = await listLiveDaemonProtocols(runtimeDir, KNOWN_PROTOCOLS)
  if (left === null || left.length > 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error('The terminal background process is still running.')
  }
}
