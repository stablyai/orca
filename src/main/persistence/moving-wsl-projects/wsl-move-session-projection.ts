/** Session and UI parts of the WSL move projection: the rows a scoped workspace owns. */
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId,
  worktreeIdForPaneKey
} from '../../../shared/workspace-session-host-records'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isRecord, parseEditorFileId } from './wsl-move-canonical-form'
import { WORKSPACE_SESSION_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-dispositions'
import { UI_STATE_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-ui-dispositions'

export type WslMoveOwnerInScope = (owner: string | undefined | null) => boolean
type OwnerInScope = WslMoveOwnerInScope
type SessionOwnership =
  (typeof WORKSPACE_SESSION_FIELD_OWNERSHIP)[keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP]

const SESSION_OWNERSHIP_BY_FIELD: ReadonlyMap<string, SessionOwnership> = new Map(
  Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)
)

export function projectWslMoveSession(
  session: Partial<WorkspaceSessionState>,
  ownerInScope: OwnerInScope
): Record<string, unknown> {
  const byTab = buildWorktreeIdByTabId(session)
  const byFile = buildWorktreeIdByFileId(session)
  const fields: Readonly<Record<string, unknown>> = session
  const out: Record<string, unknown> = {}
  for (const [field, row] of Object.entries(WORKSPACE_SESSION_DISPOSITIONS)) {
    const value = fields[field]
    const ownership = SESSION_OWNERSHIP_BY_FIELD.get(field)
    if (row.disposition !== 'move' || value == null || !ownership) {
      continue
    }
    const owned = projectSessionField(ownership, value, ownerInScope, byTab, byFile)
    if (owned !== undefined) {
      out[field] = owned
    }
  }
  return out
}

function projectSessionField(
  ownership: SessionOwnership,
  value: unknown,
  ownerInScope: OwnerInScope,
  byTab: Map<string, string>,
  byFile: Map<string, string>
): unknown {
  const record = isRecord(value) ? value : {}
  switch (ownership) {
    case 'worktreeKeyed':
      return pickKeys(record, ownerInScope)
    case 'worktreeArray':
      return Array.isArray(value) ? value.filter((id) => ownerInScope(String(id))) : undefined
    case 'tabKeyed':
      return pickKeys(record, (tabId) => ownerInScope(byTab.get(tabId)))
    case 'paneKeyed':
      return pickKeys(record, (paneKey) => ownerInScope(worktreeIdForPaneKey(byTab, paneKey)))
    case 'fileKeyed':
      return pickKeys(record, (fileId) =>
        ownerInScope(parseEditorFileId(fileId)?.[0] ?? byFile.get(fileId))
      )
    case 'sleepingAgentKeyed':
    case 'surfaceTombstoneKeyed':
      return pickEntries(record, (entry) => ownerInScope(rowOwner(entry)))
    case 'browserWorkspaceKeyed':
      return pickEntries(
        record,
        (pages) => Array.isArray(pages) && pages.some((page) => ownerInScope(rowOwner(page)))
      )
    case 'global':
      // Only global history rows that name a scoped workspace move; focus is re-projected and
      // per-environment browser intents stay with the client that owes them.
      return Array.isArray(value)
        ? value.filter((row) =>
            ownerInScope(
              rowOwner(isRecord(row) && isRecord(row.docLocation) ? row.docLocation : row)
            )
          )
        : undefined
    case 'hostPrivate':
      return undefined
  }
}

export function projectWslMoveUi(
  ui: Partial<PersistedUIState>,
  session: Partial<WorkspaceSessionState>,
  ownerInScope: OwnerInScope,
  repoEntryInScope: (repoId: unknown, hostId: unknown) => boolean
): Record<string, unknown> {
  const byTab = buildWorktreeIdByTabId(session)
  const out: Record<string, unknown> = {}
  const fields: Readonly<Record<string, unknown>> = ui
  for (const [field, row] of Object.entries(UI_STATE_DISPOSITIONS)) {
    const value = fields[field]
    if (row.disposition !== 'move' || value == null) {
      continue
    }
    if (Array.isArray(value)) {
      // Repo-id lists, and the manual repo order's `{hostId, repoId}` rows.
      out[field] = value.filter((entry: unknown) =>
        typeof entry === 'string'
          ? repoEntryInScope(entry, undefined)
          : repoEntryInScope(fieldOf(entry, 'repoId'), fieldOf(entry, 'hostId'))
      )
    } else if (field.endsWith('ByPaneKey') && isRecord(value)) {
      out[field] = pickKeys(value, (paneKey) => ownerInScope(worktreeIdForPaneKey(byTab, paneKey)))
    } else if (field === 'workspaceCleanup' && isRecord(value) && isRecord(value.dismissals)) {
      out[field] = pickKeys(value.dismissals, ownerInScope)
    } else if (typeof value === 'string') {
      out[field] = ownerInScope(value) ? value : null
    } else if (isRecord(value)) {
      out[field] = pickKeys(value, ownerInScope)
    }
  }
  return out
}

function rowOwner(row: unknown): string | undefined {
  const id = fieldOf(row, 'worktreeId') ?? fieldOf(row, 'workspaceId')
  return typeof id === 'string' ? id : undefined
}

export function fieldOf(row: unknown, key: string): unknown {
  return isRecord(row) ? row[key] : undefined
}

export function pickKeys<T>(
  record: Readonly<Record<string, T>>,
  keep: (key: string) => boolean
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)))
}

function pickEntries<T>(
  record: Readonly<Record<string, T>>,
  keep: (entry: T) => boolean
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => keep(entry)))
}
