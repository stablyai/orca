import type { SshGitProvider } from './ssh-git-provider'

const sshProviders = new Map<string, SshGitProvider>()

export function registerSshGitProvider(connectionId: string, provider: SshGitProvider): void {
  sshProviders.set(connectionId, provider)
}

export function unregisterSshGitProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
}

export function getSshGitProvider(connectionId: string): SshGitProvider | undefined {
  return sshProviders.get(connectionId)
}
