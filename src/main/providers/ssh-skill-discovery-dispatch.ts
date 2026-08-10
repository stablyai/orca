import type { SshSkillDiscoveryProvider } from './ssh-skill-discovery-provider'

const sshProviders = new Map<string, SshSkillDiscoveryProvider>()

export const SSH_SKILL_DISCOVERY_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export function registerSshSkillDiscoveryProvider(
  connectionId: string,
  provider: SshSkillDiscoveryProvider
): void {
  sshProviders.set(connectionId, provider)
}

export function unregisterSshSkillDiscoveryProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
}

export function getSshSkillDiscoveryProvider(
  connectionId: string
): SshSkillDiscoveryProvider | undefined {
  return sshProviders.get(connectionId)
}

export function requireSshSkillDiscoveryProvider(connectionId: string): SshSkillDiscoveryProvider {
  const provider = getSshSkillDiscoveryProvider(connectionId)
  if (!provider) {
    throw new Error(SSH_SKILL_DISCOVERY_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
