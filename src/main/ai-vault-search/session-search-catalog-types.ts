import type { SessionSearchRetryCommand } from './session-search-retry-transition'
import type { SessionSearchAuthorityCommand } from './session-search-observation-authority'
import type {
  SessionSearchDirtyCommand,
  SessionSearchDirtyResult
} from './session-search-dirty-transition'
import type { SessionSearchDependencyFanoutCommand } from './session-search-dependency-fanout'
import type { SessionSearchDirectoryFrontierCommand } from './session-search-directory-frontier'
import type { SessionSearchFrontierCommand } from './session-search-frontier-transition'
import type {
  SessionSearchContainerAuthority,
  SessionSearchContainerCommand
} from './session-search-container-transition'
import type { SessionSearchDependencyCommand } from './session-search-dependency-transition'
import type {
  SessionSearchDirectoryCommand,
  SessionSearchDirectoryResult
} from './session-search-directory-transition'
import type {
  SessionSearchInventoryCommand,
  SessionSearchInventoryResult
} from './session-search-inventory-transition'

export type SessionSearchCatalogRow = {
  key: string
  value: string
  parent: string
  group: string
  rank: number
  ready: number
  tie?: number
}
export type SessionSearchInputReceipt = { consumer: string; revision: number }
export type SessionSearchCatalogPosition = { key: string; rank: number; tie: number }
export type SessionSearchCatalogBaseCommand = (
  | { kind: 'get'; scope: string; key: string; physicalScope?: string }
  | { kind: 'get-page'; scope: string; keys: string[] }
  | { kind: 'release-parent'; scope: string; parent: string }
  | { kind: 'put'; scope: string; rows: SessionSearchCatalogRow[] }
  | { kind: 'delete'; scope: string; key: string }
  | { kind: 'delete-page'; scope: string; keys: string[] }
  | { kind: 'release'; scope: string }
  | { kind: 'release-scopes'; scope: string }
  | { kind: 'release-scopes-page'; scope: string }
  | { kind: 'release-prefix'; scope: string; prefix: string }
  | { kind: 'count'; scope: string; ready?: number }
  | {
      kind: 'page'
      scope: string
      after?: string
      afterOrder?: SessionSearchCatalogPosition
      parent?: string
      group?: string
      ready?: number
      orderRank?: boolean
      orderRevision?: boolean
      throughRevision?: number
      beforeRank?: number
      eligibleThrough?: number
      limit?: number
      prefix?: string
    }
) & { receipt?: SessionSearchInputReceipt }

export type SessionSearchCatalogCommand = (
  | SessionSearchRetryCommand
  | SessionSearchAuthorityCommand
  | SessionSearchDirtyCommand
  | SessionSearchDependencyFanoutCommand
  | SessionSearchDirectoryFrontierCommand
  | SessionSearchFrontierCommand
  | SessionSearchContainerCommand
  | SessionSearchDependencyCommand
  | SessionSearchDirectoryCommand
  | SessionSearchInventoryCommand
  | SessionSearchCatalogBaseCommand
) & { receipt?: SessionSearchInputReceipt }
export type SessionSearchCatalogResult = SessionSearchDirtyResult &
  SessionSearchInventoryResult &
  SessionSearchDirectoryResult & {
    directoryProtected?: boolean
    observationEpoch?: number
    dependencyMore?: boolean
    invalidProof?: boolean
    authority?: SessionSearchContainerAuthority
    accepted?: boolean
    membership?: boolean[]
    scopeCounts?: [string, number, number][]
    rows?: SessionSearchCatalogRow[]
    count?: number
    revision?: number
    processed?: number
    after?: string
  }
