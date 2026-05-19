import type { SshGitProvider } from './ssh-git-provider'

const sshProviders = new Map<string, SshGitProvider>()

export const SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export function registerSshGitProvider(connectionId: string, provider: SshGitProvider): void {
  sshProviders.set(connectionId, provider)
}

export function unregisterSshGitProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
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
