export type HostedProviderSpawn = {
  nonce: string
  source: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type HostedProviderOutcome = {
  pid: number | null
  code: number | null
  signal: NodeJS.Signals | null
  processless: boolean
  spawnErrorCode?: string
}

export type HostedProviderState =
  | { state: 'live'; pid: number }
  | { state: 'exited'; outcome: HostedProviderOutcome }
  | { state: 'unknown' }

export type HostedProviderExitEvent = {
  type: 'providerExit'
  nonce: string
  outcome: HostedProviderOutcome
}

export type HostedProviderRequest =
  | { id: string; type: 'spawnProvider'; payload: HostedProviderSpawn }
  | {
      id: string
      type: 'signalProvider'
      payload: { nonce: string; signal: NodeJS.Signals }
    }
  | { id: string; type: 'queryProvider'; payload: { nonce: string; acknowledge?: boolean } }

export const PROVIDER_SPAWN_PROTOCOL_VERSION = 57
