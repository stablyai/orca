/** The host starts the desktop app's native provider owner; every owner pipe connects back to the
 * app's private rendezvous, so the app alone holds them and ownership matches a direct launch. */
export type HostedProviderSpawn = {
  nonce: string
  path: string
  program: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** A spawn the host could not start reports its error as data, so the app classifies it as here. */
export type HostedProviderSpawnResult =
  | { pid: number }
  | { spawnError: { code: string; path?: string } }

export type HostedProviderRequest =
  | { id: string; type: 'probeProviderCwd'; payload: { cwd: string } }
  | { id: string; type: 'spawnProvider'; payload: HostedProviderSpawn }

/** Native owner pipes fds 1-7; fd 0 stays closed as on a direct launch. */
export const HOSTED_PROVIDER_PIPE_FDS = [1, 2, 3, 4, 5, 6, 7] as const

export const PROVIDER_SPAWN_PROTOCOL_VERSION = 59
