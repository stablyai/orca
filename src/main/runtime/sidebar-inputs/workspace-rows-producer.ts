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

// The settings the visibility filter reads: the defaults, and the layouts that classify a checkout.
const VISIBILITY_SETTINGS = [
  'worktreeVisibilityDefaults',
  'workspaceDir',
  'nestWorkspaces',
  'workspaceDirHistory'
] as const

function visibilitySettingsKey(store: RuntimeStore): string {
  const settings = store.getSettings()
  return JSON.stringify(VISIBILITY_SETTINGS.map((key) => settings[key] ?? null))
}

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
  // What the last snapshot's visibility filter read; null until a snapshot or settings save.
  private visibilityKey: string | null = null

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
        WORKTREE_METADATA_DOMAINS.some((domain) => domains.includes(domain)) ||
        (domains.includes('settings') && this.visibilitySettingsChanged())
      ) {
        this.revision.bump()
      }
    })
  }

  // Every settings save reports above, whichever path wrote it and whether or not it notified.
  private visibilitySettingsChanged(): boolean {
    const previous = this.visibilityKey
    this.visibilityKey = this.sources.store ? visibilitySettingsKey(this.sources.store) : null
    return previous !== null && previous !== this.visibilityKey
  }

  async snapshot(): Promise<WorkspaceRowsSnapshot> {
    const { store } = this.sources
    const revision = this.revision.value
    if (!store) {
      return { revision, rows: {} }
    }
    this.visibilityKey = visibilitySettingsKey(store)
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
