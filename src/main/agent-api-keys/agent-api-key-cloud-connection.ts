// Who the desktop writes personal Cloud secrets as. Set up by the Cloud secrets handlers, which own
// the control-plane client; until then (or in builds without Orca Cloud) keys stay on this computer.
import { app } from 'electron'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { CloudSecretsClient } from '../cloud-secrets/cloud-secrets-client'
import { getOrcaCloudAvailability } from '../hosted-sandbox/hosted-sandbox-install'
import { getOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import type { AgentApiKeyCloudConnection } from './agent-api-key-cloud-sync'

let client: CloudSecretsClient | null = null
let recorder: ((agent: TuiAgent, envName: string) => Promise<void>) | null = null

/** Lets the vault note a key the cloud workspace setup saved to the Orca account. */
export function setAgentApiKeyCloudRecorder(
  next: ((agent: TuiAgent, envName: string) => Promise<void>) | null
): void {
  recorder = next
}

export async function recordAgentApiKeyCloudWrite(agent: TuiAgent, envName: string): Promise<void> {
  await recorder?.(agent, envName).catch(() => undefined)
}

export function setAgentApiKeyCloudClient(next: CloudSecretsClient | null): void {
  client = next
}

/** The signed-in Orca account with Orca Cloud, or null: signed out, no capability, or offline. */
export async function agentApiKeyCloudConnection(): Promise<AgentApiKeyCloudConnection | null> {
  const current = client
  const generation = getOrcaProfileIndexGeneration()
  if (!current || (await getOrcaCloudAvailability()) !== 'offered') {
    return null
  }
  const accountId = ensureActiveOrcaProfile(app.getPath('userData')).profile.cloud?.userId
  // Every sign-in, sign-out and account or team switch rewrites the profile index.
  const isCurrent = (): boolean => getOrcaProfileIndexGeneration() === generation
  return accountId && isCurrent() ? { accountId, client: current, isCurrent } : null
}
