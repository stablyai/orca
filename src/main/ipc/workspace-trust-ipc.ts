import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { WorkspaceTrustEntry, WorkspaceTrustTarget } from '../../shared/workspace-trust-types'
import {
  resolveWorkspaceTrustIntake,
  type WorkspaceTrustIntakeResolution
} from '../workspace-trust/workspace-trust-intake-resolution'
import {
  recordWorkspaceTrustDecision,
  revokeWorkspaceTrustEntry
} from '../workspace-trust/workspace-trust-service'

export type WorkspaceTrustResolveIntakeResult =
  | WorkspaceTrustIntakeResolution
  | { outcome: 'not-applicable' }

function parseTarget(raw: unknown): WorkspaceTrustTarget | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const target = (raw as { target?: unknown }).target
  if (!target || typeof target !== 'object') {
    return null
  }
  const kind = (target as { kind?: unknown }).kind
  if (kind === 'repo') {
    const repoId = (target as { repoId?: unknown }).repoId
    return typeof repoId === 'string' ? { kind: 'repo', repoId } : null
  }
  if (kind === 'folderWorkspace') {
    const folderWorkspaceId = (target as { folderWorkspaceId?: unknown }).folderWorkspaceId
    return typeof folderWorkspaceId === 'string'
      ? { kind: 'folderWorkspace', folderWorkspaceId }
      : null
  }
  return null
}

/** Local-path resolution only — a remote-hosted (`connectionId` set) repo has no local filesystem root to gate. */
function resolveTargetPath(store: Store, target: WorkspaceTrustTarget): string | null {
  if (target.kind === 'repo') {
    const repo = store.getRepos().find((entry) => entry.id === target.repoId)
    if (!repo || repo.connectionId != null) {
      return null
    }
    return repo.path
  }
  return store.getFolderWorkspace(target.folderWorkspaceId)?.folderPath ?? null
}

/**
 * Every renderer-initiated intake path funnels through here. `{ target }` ids only —
 * the security invariant this channel exists to protect is that a renderer payload can
 * never supply `provenance` and obtain the `'created'` auto-trust default, which stays
 * exclusive to the in-process `repos:create` write (see design: Provenance-Based Trust
 * Defaults). The resolver itself is provenance-independent for every non-'created' value,
 * so which literal is passed below is a documentation choice, never a security boundary.
 */
async function resolveIntakeHandler(
  store: Store,
  rawArgs: unknown
): Promise<WorkspaceTrustResolveIntakeResult> {
  const target = parseTarget(rawArgs)
  if (!target) {
    return { outcome: 'not-applicable' }
  }
  const path = resolveTargetPath(store, target)
  if (path === null) {
    return { outcome: 'not-applicable' }
  }
  const provenance = target.kind === 'repo' ? 'added' : 'folder-workspace'
  return resolveWorkspaceTrustIntake(path, store, provenance)
}

async function decideHandler(store: Store, rawArgs: unknown): Promise<WorkspaceTrustEntry | null> {
  const raw = rawArgs as {
    target?: unknown
    scope?: 'workspace' | 'parent'
    decision?: 'trust' | 'decline'
  }
  const target = parseTarget(raw)
  const scope = raw?.scope === 'parent' ? 'parent' : 'workspace'
  const decision = raw?.decision === 'decline' ? 'decline' : 'trust'
  if (!target) {
    return null
  }
  const path = resolveTargetPath(store, target)
  if (path === null) {
    return null
  }
  // `recordWorkspaceTrustDecision` itself derives the parent via `dirname` when scope is
  // 'parent' — this handler's job is only to resolve `path` from the store, in main, never
  // accepting a renderer-supplied path.
  return recordWorkspaceTrustDecision(store, { path, scope, decision, origin: 'intake' })
}

async function revokeHandler(store: Store, rawArgs: unknown): Promise<boolean> {
  const entryId = (rawArgs as { entryId?: unknown })?.entryId
  if (typeof entryId !== 'string') {
    return false
  }
  return revokeWorkspaceTrustEntry(store, entryId)
}

export function registerWorkspaceTrustHandlers(_mainWindow: BrowserWindow, store: Store): void {
  ipcMain.removeHandler('workspaceTrust:resolveIntake')
  ipcMain.removeHandler('workspaceTrust:decide')
  ipcMain.removeHandler('workspaceTrust:revoke')

  ipcMain.handle('workspaceTrust:resolveIntake', (_event, rawArgs: unknown) =>
    resolveIntakeHandler(store, rawArgs)
  )
  ipcMain.handle('workspaceTrust:decide', (_event, rawArgs: unknown) =>
    decideHandler(store, rawArgs)
  )
  ipcMain.handle('workspaceTrust:revoke', (_event, rawArgs: unknown) =>
    revokeHandler(store, rawArgs)
  )
}
