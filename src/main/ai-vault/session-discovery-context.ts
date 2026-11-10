import { AsyncLocalStorage } from 'node:async_hooks'
import type { DiscoverSessionFilesArgs } from './session-scanner-discovery'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { SessionFileDiscovery } from './session-scanner-types'

export type SessionDiscoveryDependency = {
  path: string
  mode?: 'shallow' | 'recursive'
  eventsOnly?: boolean
  fileKey?: (path: string) => string | null
  eventKey?: (path: string) => string | null
  metadata?: boolean
  observe?: () => (force: boolean) => Promise<ReadonlySet<string>>
}

export type SessionDiscoveryContext = {
  files(args: DiscoverSessionFilesArgs): Promise<SessionFileDiscovery>
  container(
    key: string,
    paths: readonly string[],
    read: (paths: readonly string[], limit: number) => Promise<SessionFileDiscovery>,
    limit: number,
    issues: readonly AiVaultScanIssue[],
    enumerationComplete?: boolean
  ): Promise<SessionFileDiscovery>
  artifacts(root: string): Map<string, string>
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
  read: (paths: readonly string[], limit: number) => Promise<SessionFileDiscovery>,
  limit: number,
  issues: readonly AiVaultScanIssue[],
  enumerationComplete = true
): Promise<SessionFileDiscovery> {
  return (
    currentSessionDiscovery()?.container(key, paths, read, limit, issues, enumerationComplete) ??
    read(paths, limit)
  )
}
