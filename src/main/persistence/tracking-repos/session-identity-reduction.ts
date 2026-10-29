import type { SessionUnitReader, SessionEntry } from '../../../shared/session-unit-reader'
import type { SessionMapField } from '../../../shared/session-change-set'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  isWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import { remapBrowserPageDocLocation } from '../../../shared/browser-page-doc-location'

export function reduceSessionIdentityMove(
  reader: SessionUnitReader,
  oldId: string,
  newId: string
): void {
  const oldKey = worktreeWorkspaceKey(oldId),
    newKey = worktreeWorkspaceKey(newId)
  const repoint = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldId ? { ...value, worktreeId: newId } : value
  const browser = <T extends BrowserPage | BrowserWorkspace>(value: T): T =>
    value.docLocation?.worktreeId === oldId
      ? {
          ...repoint(value),
          docLocation: remapBrowserPageDocLocation(
            value.docLocation,
            oldId,
            newId,
            splitWorktreeIdForFilesystem(oldId)?.worktreePath,
            splitWorktreeIdForFilesystem(newId)?.worktreePath
          )
        }
      : repoint(value)
  const move = <F extends SessionMapField>(
    field: F,
    transform: (value: SessionEntry<F>) => SessionEntry<F> = (value) => value
  ): void => {
    // Preserve source-over-target collision policy, including repeated/partial moves.
    for (const [from, to] of [
      [oldId, newId],
      [oldKey, newKey]
    ]) {
      const value = reader.unit(field, from)
      if (!value.present) {
        continue
      }
      reader.write(field, to, { present: true, value: transform(value.value) })
      reader.write(field, from, { present: false, value: undefined })
    }
  }
  move('tabsByWorktree', (rows) => rows.map(repoint))
  move('openFilesByWorktree', (rows) => rows.map(repoint))
  move('browserTabsByWorktree', (rows) => rows.map(browser))
  move('clientHostedBrowserPagesByWorktree', (rows) =>
    rows.map((row) => (row.workspaceId === oldId ? { ...row, workspaceId: newId } : row))
  )
  move('unifiedTabs', (rows) => rows.map(repoint))
  move('tabGroups', (rows) => rows.map(repoint))
  for (const field of [
    'activeFileIdByWorktree',
    'activeBrowserTabIdByWorktree',
    'activeTabTypeByWorktree',
    'activeTabIdByWorktree',
    'tabGroupLayouts',
    'activeGroupIdByWorktree',
    'defaultTerminalTabsAppliedByWorktreeId'
  ] as const) {
    move(field)
  }
  for (const unit of reader.references('owner', oldId, 'prior')) {
    const { field, key } = unit
    if (field === 'browserPagesByWorkspace') {
      const pages = reader.unit(field, key).value
      if (
        pages?.some((page) => page.worktreeId === oldId || page.docLocation?.worktreeId === oldId)
      ) {
        reader.write(field, key, { present: true, value: pages.map(browser) })
      }
    } else if (field === 'lastVisitedAtByWorktreeId') {
      const rawId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      if (rawId !== oldId) {
        continue
      }
      const value = reader.unit(field, key).value
      if (value === undefined) {
        continue
      }
      const nextKey = isWorktreeHostIdentity(key)
        ? `${key.slice(0, key.length - rawId.length)}${newId}`
        : newId
      reader.write(field, nextKey, {
        present: true,
        value: Math.max(reader.unit(field, nextKey).value ?? value, value)
      })
      reader.write(field, key, { present: false, value: undefined })
    } else if (
      field === 'sleepingAgentSessionsByPaneKey' ||
      field === 'terminalSurfaceTombstonesByPaneKey' ||
      field === 'closedTerminalTabTombstonesByTabId' ||
      field === 'closedTerminalPanesByPaneKey'
    ) {
      const value = reader.unit(field, key).value
      if (value?.worktreeId === oldId) {
        reader.write(field, key, { present: true, value: { ...value, worktreeId: newId } })
      }
    } else if (field === 'clientHostedBrowserCloseIntentsByEnvironment') {
      const rows = reader.unit(field, key).value
      if (rows?.some((row) => row.worktreeId === oldId)) {
        reader.write(field, key, { present: true, value: rows.map((row) => repoint(row)) })
      }
    } else if (field === 'pairedTerminalTabCloseIntentsByEnvironment') {
      const rows = reader.unit(field, key).value
      if (rows?.some((row) => row.worktreeId === oldId)) {
        reader.write(field, key, { present: true, value: rows.map((row) => repoint(row)) })
      }
    }
  }
  const active = reader.field('activeWorktreeIdsOnShutdown')
  if (active.value?.includes(oldId)) {
    reader.replace('activeWorktreeIdsOnShutdown', {
      present: true,
      value: active.value.map((id) => (id === oldId ? newId : id))
    })
  }
  if (reader.field('activeWorktreeId').value === oldId) {
    reader.replace('activeWorktreeId', { present: true, value: newId })
  }
  if (reader.field('activeWorkspaceKey').value === oldKey) {
    reader.replace('activeWorkspaceKey', { present: true, value: newKey })
  }
}
