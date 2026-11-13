import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import { HostedProviderChild } from './hosted-provider-child'
import type { ProviderChild } from './provider-child'
import type { createProviderSpawnSpec } from './provider-process-supervisor'

let hostClient: (() => Promise<DaemonClient | null>) | null = null

/** Only desktop composition installs this route; server and remote launchers keep direct spawn. */
export function installProviderProcessHost(getClient: () => Promise<DaemonClient | null>): void {
  hostClient = getClient
}

export function spawnProviderProcess(
  spec: ReturnType<typeof createProviderSpawnSpec>,
  spawnImpl: PipedProcessSpawner = spawnProcess,
  allowHost = true
): ProviderChild {
  const direct = (): ReturnType<PipedProcessSpawner> =>
    spawnImpl({
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      detached: spec.detached,
      stdio: ['pipe', 'pipe', 'pipe', ...spec.groupReportStdio]
    })
  const getClient = hostClient
  if (!getClient || !spec.supervised || !allowHost) {
    return direct()
  }
  return new HostedProviderChild(
    spec,
    async () => {
      try {
        const client = await getClient()
        if (!client) {
          return null
        }
        await client.ensureConnectedWithin(1_000)
        if (!client.getDaemonIdentity()?.providerSpawn) {
          return null
        }
        // No spawn has been sent yet, so a hung host can safely use the direct launch path.
        await client.request('ping', undefined, 1_000)
        return client
      } catch {
        return null
      }
    },
    direct
  )
}
