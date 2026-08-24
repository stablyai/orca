import type { IFilesystemProvider } from './types'

const sshProviders = new Map<string, IFilesystemProvider>()

export const SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

// Why: a reconnect builds a fresh provider, so anything holding remote state tied to the old
// transport (file watches) needs a signal to rebuild it — nothing else marks that boundary.
const registrationListeners = new Set<(connectionId: string) => void>()
const providerChangeListeners = new Set<(connectionId: string, generation: number) => void>()
const providerGenerations = new Map<string, number>()

function bumpProviderGeneration(connectionId: string): number {
  const generation = (providerGenerations.get(connectionId) ?? 0) + 1
  providerGenerations.set(connectionId, generation)
  for (const listener of providerChangeListeners) {
    try {
      listener(connectionId, generation)
    } catch (error) {
      console.warn('[ssh-filesystem] provider change listener failed:', error)
    }
  }
  return generation
}

export function onSshFilesystemProviderChanged(
  listener: (connectionId: string, generation: number) => void
): () => void {
  providerChangeListeners.add(listener)
  return () => providerChangeListeners.delete(listener)
}

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
  bumpProviderGeneration(connectionId)
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
  bumpProviderGeneration(connectionId)
}

export function getSshFilesystemProvider(connectionId: string): IFilesystemProvider | undefined {
  return sshProviders.get(connectionId)
}

export function getSshFilesystemProviderSnapshot(connectionId: string): {
  provider: IFilesystemProvider
  generation: number
} | null {
  const provider = sshProviders.get(connectionId)
  return provider ? { provider, generation: providerGenerations.get(connectionId) ?? 0 } : null
}

export function requireSshFilesystemProvider(connectionId: string): IFilesystemProvider {
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider) {
    throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
