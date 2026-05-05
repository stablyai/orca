import type { IGitProvider } from './types'

const sshProviders = new Map<string, IGitProvider>()

export function registerSshGitProvider(connectionId: string, provider: IGitProvider): void {
  sshProviders.set(connectionId, provider)
}

export function unregisterSshGitProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
}

export function getSshGitProvider(connectionId: string): IGitProvider | undefined {
  return sshProviders.get(connectionId)
}
