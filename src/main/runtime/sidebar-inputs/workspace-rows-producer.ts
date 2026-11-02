import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  buildWorkspaceRows,
  type WorkspaceRowsSnapshot
} from '../../../shared/sidebar-list/workspace-rows'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import { runtimeVisibleFolderWorkspaces } from '../runtime-visible-catalog'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/loading-store/worktree-identity-metadata'
import { ProducerRevision } from './producer-revision'

export type WorkspaceRowsSources = {
  store: RuntimeStore | null
  /** A freshly merged listing, never the shared cache, through worktree.ps's visibility filters. */
  listVisibleWorktrees: () => Promise<ResolvedWorktreeSnapshot>
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

/**
 * This host's workspace rows, read on demand. The revision moves on catalog changes and on saves
 * that may touch metadata; session saves are tagged apart, so terminal output never moves it.
 */
export class WorkspaceRowsProducer {
  readonly revision = new ProducerRevision()

  constructor(private readonly sources: WorkspaceRowsSources) {
    sources.onClientEvent(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.revision.bump()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    // A full save may be a folder workspace or lineage write.
    sources.store?.onStateWritten?.((domains) => {
      if (
        domains === undefined ||
        WORKTREE_METADATA_DOMAINS.some((domain) => domains.includes(domain))
      ) {
        this.revision.bump()
      }
    })
  }

  async snapshot(): Promise<WorkspaceRowsSnapshot> {
    const { store } = this.sources
    const revision = this.revision.value
    if (!store) {
      return { revision, rows: {} }
    }
    const { worktrees, platformByRepoId } = await this.sources.listVisibleWorktrees()
    const rows = buildWorkspaceRows({
      worktrees,
      folderWorkspaces: runtimeVisibleFolderWorkspaces(store),
      repos: store.getRepos(),
      lineageById: store.getAllWorktreeLineage?.() ?? {}
    })
    for (const row of rows.values()) {
      const terminalPlatform = row.kind === 'git' ? platformByRepoId.get(row.repoId) : undefined
      if (terminalPlatform) {
        row.terminalPlatform = terminalPlatform
      }
    }
    return { revision, rows: Object.fromEntries(rows) }
  }
}
