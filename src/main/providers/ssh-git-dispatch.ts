import type { SshGitProvider } from './ssh-git-provider'

const sshProviders = new Map<string, SshGitProvider>()
const sshProviderRegistrationIds = new Map<string, number>()
let nextSshProviderRegistrationId = 1

export const SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export function registerSshGitProvider(connectionId: string, provider: SshGitProvider): void {
  sshProviders.set(connectionId, provider)
  // Why: connection ids can be removed and reused; cache consumers need a
  // lightweight lifecycle identity that does not retain the provider graph.
  sshProviderRegistrationIds.set(connectionId, nextSshProviderRegistrationId)
  nextSshProviderRegistrationId += 1
}

export function unregisterSshGitProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
  sshProviderRegistrationIds.delete(connectionId)
}

export function getSshGitProvider(connectionId: string): SshGitProvider | undefined {
  return sshProviders.get(connectionId)
}

export function getSshGitProviderRegistrationId(connectionId: string): number | undefined {
  return sshProviderRegistrationIds.get(connectionId)
}

export function requireSshGitProvider(connectionId: string): SshGitProvider {
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
