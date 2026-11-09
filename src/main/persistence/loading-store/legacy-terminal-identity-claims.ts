import {
  catalogEpoch,
  type LegacyClaimState,
  type LegacyClaimLayout,
  type LegacyTerminalCatalogEpoch
} from './legacy-terminal-claim-contract'
export type * from './legacy-terminal-claim-contract'
import { realpath } from 'node:fs/promises'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import {
  isWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { resolveFolderWorkspaceRowHost } from '../../../shared/folder-workspaces/folder-workspace-execution-host'

const claimsByState = new WeakMap<object, LegacyTerminalIdentityClaims>()
const claimsByRuntime = new WeakMap<object, LegacyTerminalIdentityClaims>()
const numeric = (id: unknown): id is string => typeof id === 'string' && /^\d+$/.test(id)
const ownerKey = (workspace: string, pane: string) => JSON.stringify([workspace, pane])

/** Claims are monotone: removal or rollback never makes a previously shared number unique. */
export class LegacyTerminalIdentityClaims {
  private readonly owners = new Map<string, object | null>()
  private readonly locations = new Map<string, object>()
  private readonly workspaceKinds = new Map<string, 'local' | 'foreign' | 'unknown'>()
  private readonly repoKinds = new Map<string, 'local' | 'foreign' | 'unknown'>()
  revision = 0
  canonicalProfile: string | undefined
  canonicalProfileReady: Promise<void> = Promise.resolve()
  private externalCatalog = catalogEpoch(true)

  constructor(private readonly state: LegacyClaimState) {
    this.refreshCatalog(false)
    this.observeMembership()
  }

  refreshCatalog(observeChanges = true, includeMembership = false): void {
    const { state } = this
    const priorKinds = new Map(this.workspaceKinds)
    const priorRepos = new Map(this.repoKinds)
    this.workspaceKinds.clear()
    this.repoKinds.clear()
    this.revision++
    for (const repo of state.repos) {
      const kind =
        !repo.orcadRetained && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
          ? 'local'
          : 'foreign'
      const prior = this.repoKinds.get(repo.id)
      this.repoKinds.set(repo.id, prior ? 'unknown' : kind)
    }
    for (const folder of state.folderWorkspaces ?? []) {
      const host = resolveFolderWorkspaceRowHost(state, folder)
      const kind =
        folder.orcadRetained || host.kind === 'ssh' || host.kind === 'runtime'
          ? 'foreign'
          : host.kind === 'local'
            ? 'local'
            : 'unknown'
      const key = `folder:${folder.id}`
      const prior = this.workspaceKinds.get(key)
      this.workspaceKinds.set(key, prior ? 'unknown' : kind)
    }
    if (!observeChanges) {
      return
    }
    if (includeMembership) {
      this.observeMembership()
      return
    }
    for (const [workspace, rows] of Object.entries(state.workspaceSession.tabsByWorktree ?? {})) {
      const key = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
      const previous =
        priorKinds.get(key) ?? priorRepos.get(getRepoIdFromWorktreeId(key)) ?? 'unknown'
      if (previous !== this.kind(key)) {
        for (const row of rows) {
          this.observeRow(
            workspace,
            row,
            state.workspaceSession.terminalLayoutsByTabId?.[row.id],
            state.workspaceSession.remoteSessionIdsByTabId?.[row.id]
          )
        }
      }
    }
  }

  private observeMembership(): void {
    const session = this.state.workspaceSession
    for (const [workspace, rows] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const row of rows) {
        this.observeRow(
          workspace,
          row,
          session.terminalLayoutsByTabId?.[row.id],
          session.remoteSessionIdsByTabId?.[row.id]
        )
      }
    }
    const tabs = new Set(
      Object.values(session.tabsByWorktree ?? {}).flatMap((rows) => rows.map((row) => row.id))
    )
    for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
      if (!tabs.has(tabId)) {
        this.observeLayout(undefined, tabId, layout)
      }
    }
  }

  private kind(workspace: string): 'local' | 'foreign' | 'unknown' {
    return (
      this.workspaceKinds.get(workspace) ??
      this.repoKinds.get(getRepoIdFromWorktreeId(workspace)) ??
      'unknown'
    )
  }

  private claimant(key: string): object {
    let token = this.locations.get(key)
    if (!token) {
      token = {}
      this.locations.set(key, token)
    }
    return token
  }

  transfer(workspace: string, source: string, destination: string): (() => void) | undefined {
    workspace = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
    const from = ownerKey(workspace, source)
    const to = ownerKey(workspace, destination)
    const token = this.locations.get(from)
    if (!token || this.locations.has(to)) {
      return
    }
    this.locations.delete(from)
    this.locations.set(to, token)
    return () => {
      if (this.locations.get(to) === token && !this.locations.has(from)) {
        this.locations.delete(to)
        this.locations.set(from, token)
      }
    }
  }

  private admit(id: unknown, key: string | null): void {
    if (!numeric(id)) {
      return
    }
    const owner = key === null ? null : this.claimant(key)
    if (!this.owners.has(id)) {
      this.owners.set(id, owner)
    } else if (this.owners.get(id) !== owner) {
      this.owners.set(id, null)
    }
  }

  observeBinding(workspace: string, pane: string, id: string): void {
    if (
      isWorktreeHostIdentity(workspace) &&
      getExecutionHostIdFromWorktreeHostIdentity(workspace) !== LOCAL_EXECUTION_HOST_ID
    ) {
      return
    }
    workspace = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
    if (this.kind(workspace) === 'foreign') {
      return
    }
    this.admit(id, this.kind(workspace) === 'local' ? ownerKey(workspace, pane) : null)
  }

  observeLayout(workspace: string | undefined, tabId: string, layout: LegacyClaimLayout): void {
    for (const [leafId, id] of Object.entries(layout.ptyIdsByLeafId ?? {})) {
      if (workspace) {
        this.observeBinding(workspace, makePaneKey(tabId, leafId), id)
      } else {
        this.admit(id, null)
      }
    }
  }

  observeRow(
    workspace: string,
    row: { id: string; ptyId?: string | null },
    layout?: LegacyClaimLayout,
    remoteId?: string
  ): void {
    if (
      isWorktreeHostIdentity(workspace) &&
      getExecutionHostIdFromWorktreeHostIdentity(workspace) !== LOCAL_EXECUTION_HOST_ID
    ) {
      return
    }
    workspace = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
    if (this.kind(workspace) === 'foreign') {
      return
    }
    if (layout) {
      this.observeLayout(workspace, row.id, layout)
    }
    for (const tabId of [row.ptyId, remoteId]) {
      if (!numeric(tabId)) {
        continue
      }
      const leaves = Object.entries(layout?.ptyIdsByLeafId ?? {}).filter(([, id]) => id === tabId)
      const leafId =
        leaves.length === 1
          ? leaves[0][0]
          : !leaves.length && layout?.root?.type === 'leaf'
            ? layout.root.leafId
            : undefined
      this.admit(
        tabId,
        leafId && this.kind(workspace) === 'local'
          ? ownerKey(workspace, makePaneKey(row.id, leafId))
          : null
      )
    }
  }

  isLocalWorkspace(workspace: string): boolean {
    return (
      (!isWorktreeHostIdentity(workspace) ||
        getExecutionHostIdFromWorktreeHostIdentity(workspace) === LOCAL_EXECUTION_HOST_ID) &&
      this.kind(normalizeWorkspaceSessionKeyToWorkspaceId(workspace)) === 'local'
    )
  }

  potentiallyLocalNumericIds(): string[] {
    return [...this.owners.keys()]
  }

  captureExternalCatalog(): LegacyTerminalCatalogEpoch {
    return this.externalCatalog
  }

  invalidateExternalCatalog(): LegacyTerminalCatalogEpoch {
    this.externalCatalog.finish(false)
    this.externalCatalog = catalogEpoch(false)
    this.revision++
    return this.externalCatalog
  }

  publishExternalCatalog(
    epoch: LegacyTerminalCatalogEpoch,
    ids: readonly string[],
    complete: boolean
  ): void {
    if (epoch !== this.externalCatalog) {
      return
    }
    if (complete) {
      for (const id of ids) {
        this.admit(id, null)
      }
      epoch.complete = true
      this.revision++
    }
    epoch.finish(complete)
  }

  unique(workspace: string, pane: string, id: string): boolean {
    workspace = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
    return (
      this.externalCatalog.complete &&
      this.kind(workspace) === 'local' &&
      numeric(id) &&
      this.owners.has(id) &&
      this.owners.get(id) === this.locations.get(ownerKey(workspace, pane))
    )
  }
}

export function initializeLegacyTerminalIdentityClaims(runtime: {
  state: PersistedState
  userDataPath?: string
}): LegacyTerminalIdentityClaims {
  const claims = new LegacyTerminalIdentityClaims(runtime.state)
  claimsByRuntime.set(runtime, claims)
  claimsByState.set(runtime.state, claims)
  if (runtime.userDataPath) {
    claims.canonicalProfileReady = realpath(runtime.userDataPath)
      .then((path) => {
        claims.canonicalProfile = path
      })
      .catch(() => {})
  }
  return claims
}

export function legacyTerminalIdentityClaims(runtime: {
  state: PersistedState
}): LegacyTerminalIdentityClaims | undefined {
  return claimsByRuntime.get(runtime)
}

export function observeLegacyTerminalBinding(
  runtime: { state: PersistedState },
  binding: { tabId: string; leafId: string; ptyId: string },
  hostId: string,
  workspace: string
): void {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    legacyTerminalIdentityClaims(runtime)?.observeBinding(
      workspace,
      makePaneKey(binding.tabId, binding.leafId),
      binding.ptyId
    )
  }
}

/** Actual catalog mutations publish classification before another acquisition can inspect it. */
export function notifyLegacyTerminalCatalogChanged(
  state: Pick<PersistedState, 'repos'>,
  includesMembership = false
): void {
  claimsByState.get(state)?.refreshCatalog(true, includesMembership)
}
