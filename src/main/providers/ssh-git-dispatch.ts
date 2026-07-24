import type { SshGitProvider } from './ssh-git-provider'

const sshProviders = new Map<string, SshGitProvider>()
const sshProviderGenerations = new Map<string, number>()

export const SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export function registerSshGitProvider(connectionId: string, provider: SshGitProvider): void {
  sshProviders.set(connectionId, provider)
  sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
}

export function unregisterSshGitProvider(connectionId: string): void {
  if (sshProviders.delete(connectionId)) {
    sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
  }
}

export function getSshGitProviderGeneration(connectionId: string): number {
  return sshProviderGenerations.get(connectionId) ?? 0
}

export function getSshGitProvider(connectionId: string): SshGitProvider | undefined {
  return sshProviders.get(connectionId)
}

export function requireSshGitProvider(connectionId: string): SshGitProvider {
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
