import type { IFilesystemProvider } from './types'

const sshProviders = new Map<string, IFilesystemProvider>()

export function registerSshFilesystemProvider(
  connectionId: string,
  provider: IFilesystemProvider
): void {
  sshProviders.set(connectionId, provider)
}

export function unregisterSshFilesystemProvider(connectionId: string): void {
  sshProviders.delete(connectionId)
}

export function getSshFilesystemProvider(connectionId: string): IFilesystemProvider | undefined {
  return sshProviders.get(connectionId)
}
