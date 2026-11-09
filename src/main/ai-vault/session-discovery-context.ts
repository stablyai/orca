import { AsyncLocalStorage } from 'node:async_hooks'
import type { DiscoverSessionFilesArgs } from './session-scanner-discovery'
import type { SessionFileDiscovery } from './session-scanner-types'

export type SessionDiscoveryDependency = {
  path: string
  fileKey?: (path: string) => string | null
  eventKey?: (path: string) => string | null
  metadata?: boolean
  snapshot?: () => Promise<ReadonlyMap<string, string>>
}

export type SessionDiscoveryContext = {
  files(args: DiscoverSessionFilesArgs): Promise<SessionFileDiscovery>
  container(
    key: string,
    paths: readonly string[],
    read: () => Promise<SessionFileDiscovery>
  ): Promise<SessionFileDiscovery>
  artifacts(root: string): Map<string, string>
  membership(key: string): ReadonlySet<string> | undefined
}

const discoveryContext = new AsyncLocalStorage<SessionDiscoveryContext>()

export function currentSessionDiscovery(): SessionDiscoveryContext | undefined {
  return discoveryContext.getStore()
}

export function withSessionDiscovery<T>(context: SessionDiscoveryContext, read: () => Promise<T>) {
  return discoveryContext.run(context, read)
}

export function discoverSessionContainer(
  key: string,
  paths: readonly string[],
  read: () => Promise<SessionFileDiscovery>
): Promise<SessionFileDiscovery> {
  return currentSessionDiscovery()?.container(key, paths, read) ?? read()
}
