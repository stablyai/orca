// Who the desktop writes personal Cloud secrets as. Set up by the Cloud secrets handlers, which own
// the control-plane client; until then (or in builds without Orca Cloud) keys stay on this computer.
import { app } from 'electron'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { CloudSecretsClient } from '../cloud-secrets/cloud-secrets-client'
import { getOrcaCloudAvailability } from '../hosted-sandbox/hosted-sandbox-install'
import { getOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import type { AgentApiKeyCloudLink } from './agent-api-key-cloud-sync'

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

let forgetter: ((envNames: readonly string[]) => Promise<void>) | null = null

/** Lets the vault stop claiming personal variables the user changed or deleted in Settings › Cloud secrets. */
export function setAgentApiKeyCloudForgetter(next: ((envNames: readonly string[]) => Promise<void>) | null): void {
  forgetter = next
}

export async function forgetAgentApiKeyCloudVariables(envNames: readonly string[]): Promise<void> {
  if (envNames.length > 0) {
    await forgetter?.(envNames).catch(() => undefined)
  }
}

export function setAgentApiKeyCloudClient(next: CloudSecretsClient | null): void {
  client = next
}

/**
 * Where this desktop stands with the Orca account. Signed in but `unavailable` means the session
 * couldn't be refreshed (offline), not a sign-out: the account is still the profile's.
 */
export async function agentApiKeyCloudLink(): Promise<AgentApiKeyCloudLink> {
  const current = client
  const generation = getOrcaProfileIndexGeneration()
  if (!current) {
    return { kind: 'signed-out' }
  }
  const availability = await getOrcaCloudAvailability()
  const accountId = ensureActiveOrcaProfile(app.getPath('userData')).profile.cloud?.userId
  // Every sign-in, sign-out and account or team switch rewrites the profile index.
  const isCurrent = (): boolean => getOrcaProfileIndexGeneration() === generation
  if (!accountId || !isCurrent()) {
    return { kind: 'signed-out' }
  }
  if (availability === 'offered') {
    return { kind: 'connected', connection: { accountId, client: current, isCurrent } }
  }
  return availability === 'unavailable'
    ? { kind: 'unreachable', accountId }
    : { kind: 'signed-out' }
}
