import type { IFilesystemProvider } from './types'

const sshProviders = new Map<string, IFilesystemProvider>()
const sshProviderGenerations = new Map<string, number>()

export const SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

// Why: a reconnect builds a fresh provider, so anything holding remote state tied to the old
// transport (file watches) needs a signal to rebuild it — nothing else marks that boundary.
const registrationListeners = new Set<(connectionId: string) => void>()
const generationChangeListeners = new Set<(connectionId: string) => void>()

function notifyGenerationChanged(connectionId: string): void {
  for (const listener of generationChangeListeners) {
    try {
      listener(connectionId)
    } catch (error) {
      // Why: provider lifecycle must not fail because a cache invalidator threw.
      console.warn('[ssh-filesystem] provider generation listener failed:', error)
    }
  }
}

export function onSshFilesystemProviderGenerationChanged(
  listener: (connectionId: string) => void
): () => void {
  generationChangeListeners.add(listener)
  return () => {
    generationChangeListeners.delete(listener)
  }
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
  sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
  sshProviders.set(connectionId, provider)
  notifyGenerationChanged(connectionId)
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
  if (sshProviders.delete(connectionId)) {
    sshProviderGenerations.set(connectionId, (sshProviderGenerations.get(connectionId) ?? 0) + 1)
    notifyGenerationChanged(connectionId)
  }
}

export function getSshFilesystemProvider(connectionId: string): IFilesystemProvider | undefined {
  return sshProviders.get(connectionId)
}

export function getSshFilesystemProviderGeneration(connectionId: string): number {
  return sshProviderGenerations.get(connectionId) ?? 0
}

export function requireSshFilesystemProvider(connectionId: string): IFilesystemProvider {
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider) {
    throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return provider
}
