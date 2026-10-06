import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { resolveOrcadDeploymentTargetFacts } from './orcad-deployment-target'
import { ensureRemoteOrcadNodeRuntime, type RemoteRuntimeStep } from './orcad-remote-node-runtime'
import { materializeNodeRuntimeArchive } from './pinned-runtime-materializer'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { pinnedRuntimeTargetForHost } from './ssh-relay-runtime-ladder'

const DOWNLOAD_TIMEOUT_MS = 180_000
const downloads = new Map<string, Promise<string>>()

/**
 * The pinned Node for hosts whose own Node cannot read OpenCode's database (design D4a). Every
 * host, Windows included, installs it into the shared runtimes/ store as the official archive
 * with a `.verified` marker; nothing here touches vault-sqlite/, which old relays' references
 * still name. `runtimeSha256` is the ref the relay dir must carry so store GC keeps it.
 */
export async function preparePinnedNodeForVault(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  relayDir: string
  cacheRoot?: string
  signal: AbortSignal
  exec: (command: string) => Promise<string>
  remote: RemoteRuntimeStep
}): Promise<{ executable: string; runtimeSha256: string }> {
  const { conn, host, signal, exec } = options
  const facts = await resolveOrcadDeploymentTargetFacts({ conn, host, signal, exec })
  // Why before any upload: below every runtime's glibc floor the self-test could only fail.
  const target = pinnedRuntimeTargetForHost(facts)
  if (!target) {
    const glibc = facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : 'unknown'
    throw new Error(`No Orca-managed Node runs on this host's glibc ${glibc}`)
  }
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const { executable } = await ensureRemoteOrcadNodeRuntime({
    conn,
    host,
    slotDir: options.relayDir,
    target,
    archivePath: () => cachedArchive(target, cacheRoot, signal),
    signal,
    remoteStep: options.remote
  })
  return { executable, runtimeSha256: pinnedNodeRuntimeAsset(target).executableSha256 }
}

function cachedArchive(
  target: NodeRuntimeTarget,
  cacheRoot: string,
  signal: AbortSignal
): Promise<string> {
  const key = `${cacheRoot}\0${target}`
  let pending = downloads.get(key)
  if (!pending) {
    pending = materializeNodeRuntimeArchive(target, cacheRoot, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    }).finally(() => downloads.delete(key))
    downloads.set(key, pending)
  }
  return waitForPromiseWithSignal(pending, signal)
}
