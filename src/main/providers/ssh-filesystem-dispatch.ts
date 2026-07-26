import type { IFilesystemProvider } from './types'

const sshProviders = new Map<string, IFilesystemProvider>()

export const SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

// Why: a reconnect builds a fresh provider, so anything holding remote state tied to the old
// transport (file watches) needs a signal to rebuild it — nothing else marks that boundary.
const registrationListeners = new Set<(connectionId: string) => void>()

export function onSshFilesystemProviderRegistered(
  listener: (connectionId: string) => void
): () => void {
  registrationListeners.add(listener)
  return () => {
    registrationListeners.delete(listener)
  }
}

export function registerSshFilesystemProvider(
  connectionId: string,
  provider: IFilesystemProvider
): void {
  sshProviders.set(connectionId, provider)
  for (const listener of registrationListeners) {
    try {
      listener(connectionId)
    } catch (error) {
      // Why: relay establish must not fail because a subscriber threw.
      console.warn('[ssh-filesystem] provider registration listener failed:', error)
    }
  }
}

export function unregisterSshFilesystemProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
}

export function getSshFilesystemProvider(connectionId: string): IFilesystemProvider | undefined {
  return sshProviders.get(connectionId)
}

export function requireSshFilesystemProvider(connectionId: string): IFilesystemProvider {
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider) {
    throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
