import type {
  HostedProviderSpawn,
  HostedProviderSpawnResult
} from '../../daemon/protocol/daemon-provider-process-protocol'

export const PROVIDER_LAUNCHER_WORKER_FILENAME = 'provider-launcher-worker-entry.js'

export type ProviderLauncherRequest = { id: number; launch: HostedProviderSpawn }

export type ProviderLauncherReply =
  | { id: number; result: HostedProviderSpawnResult }
  | { id: number; error: string }
