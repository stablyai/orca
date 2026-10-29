import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'
import {
  ownerKeyBelongsToRepo,
  isRepoWorktreeId
} from '../../orca-profiles/profile-project-worktree-identity'
import { markdownFileIdCandidates } from '../../orca-profiles/profile-session-markdown-transfer'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { SessionUnitReader } from '../../../shared/session-unit-reader'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

import { isSessionMapField } from '../../../shared/session-change-set'
import { OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER } from './session-owner-fields'

/** Owner identity is an operation input even when it has never held a row. */
export function reduceSessionOwnerRemoval(
  reader: SessionUnitReader,
  owner: string,
  advanceRevision: boolean
): void {
  const tabs = reader.unit('tabsByWorktree', owner).value ?? []
  const removed = new Set(tabs.map((tab) => tab.id))
  const browserWorkspaces = reader.unit('browserTabsByWorktree', owner).value ?? []
  for (const field of OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER) {
    if (isSessionMapField(field)) {
      reader.write(field, owner, { present: false, value: undefined })
    }
  }
  for (const tab of tabs) {
    reader.write('terminalLayoutsByTabId', tab.id, { present: false, value: undefined })
  }
  for (const workspace of browserWorkspaces) {
    reader.write('browserPagesByWorkspace', workspace.id, { present: false, value: undefined })
  }
  reader.write('browserTabsByWorktree', owner, { present: false, value: undefined })
  reader.write('tabsByWorktree', owner, { present: false, value: undefined })
  for (const unit of reader.references('owner', owner, 'prior')) {
    if (unit.field === 'lastVisitedAtByWorktreeId') {
      reader.write(unit.field, unit.key, { present: false, value: undefined })
    }
    if (
      unit.field === 'sleepingAgentSessionsByPaneKey' ||
      unit.field === 'terminalSurfaceTombstonesByPaneKey' ||
      unit.field === 'closedTerminalTabTombstonesByTabId' ||
      unit.field === 'closedTerminalPanesByPaneKey'
    ) {
      if (reader.unit(unit.field, unit.key).value?.worktreeId === owner) {
        reader.write(unit.field, unit.key, { present: false, value: undefined })
      }
    }
  }
  for (const tab of removed) {
    for (const unit of reader.references('tab', tab, 'prior')) {
      if (unit.field === 'terminalPtyIncarnationsByPaneKey') {
        reader.write(unit.field, unit.key, { present: false, value: undefined })
      }
    }
  }
  for (const field of [
    'sleepingAgentSessionsByPaneKey',
    'terminalPtyIncarnationsByPaneKey',
    'closedTerminalTabTombstonesByTabId'
  ] as const) {
    reader.reconcileField(field, {
      kind: 'replacement',
      present: Object.hasOwn(reader.prior, field)
    })
  }
  if (advanceRevision) {
    const repo = getRepoIdFromWorktreeId(owner)
    reader.write('terminalTopologyRevisionByRepoId', repo, {
      present: true,
      value: (reader.unit('terminalTopologyRevisionByRepoId', repo).value ?? 0) + 1
    })
  }
  if (removed.has(reader.field('activeTabId').value ?? '')) {
    reader.replace('activeTabId', { present: true, value: null })
  }
  if (reader.field('activeWorktreeId').value === owner) {
    reader.replace('activeWorktreeId', { present: true, value: null })
  }
  const key = reader.field('activeWorkspaceKey').value
  if (key === owner || key === worktreeWorkspaceKey(owner)) {
    reader.replace('activeWorkspaceKey', { present: true, value: null })
  }
  const active = reader.field('activeWorktreeIdsOnShutdown')
  reader.replace('activeWorktreeIdsOnShutdown', {
    present: true,
    value: active.value?.filter((id) => id !== owner)
  })
}

export function reduceSessionRepoRemoval(reader: SessionUnitReader, repoId: string): void {
  const references = reader.references('repo', repoId, 'prior')
  const tabs = new Set<string>()
  for (const { field, key } of references) {
    if (field === 'tabsByWorktree' && ownerKeyBelongsToRepo(key, repoId)) {
      for (const row of reader.unit(field, key).value ?? []) {
        tabs.add(row.id)
      }
      reader.write(field, key, { present: false, value: undefined })
    }
    if (field === 'openFilesByWorktree' && ownerKeyBelongsToRepo(key, repoId)) {
      for (const file of reader.unit(field, key).value ?? []) {
        for (const id of markdownFileIdCandidates(file.filePath, key, file.runtimeEnvironmentId)) {
          reader.write('markdownFrontmatterVisible', id, { present: false, value: undefined })
        }
      }
    }
    if (field === 'browserTabsByWorktree' && ownerKeyBelongsToRepo(key, repoId)) {
      for (const browser of reader.unit(field, key).value ?? []) {
        reader.write('browserPagesByWorkspace', browser.id, { present: false, value: undefined })
      }
      reader.write(field, key, { present: false, value: undefined })
    }
    if (field === 'terminalSurfaceTombstonesByPaneKey') {
      const record = reader.unit(field, key).value
      if (record && ownerKeyBelongsToRepo(record.worktreeId, repoId)) {
        reader.write(field, key, { present: false, value: undefined })
      }
    }
    if (
      SESSION_FIELDS_PRUNED_BY_OWNER_KEY.some((name) => name === field) &&
      ownerKeyBelongsToRepo(key, repoId)
    ) {
      reader.write(field, key, { present: false, value: undefined })
    }
  }
  for (const field of SESSION_FIELDS_PRUNED_BY_OWNER_KEY) {
    if (isSessionMapField(field) && !reader.hasField(field)) {
      reader.replace(field, { present: true, value: {} })
    }
  }
  for (const tab of tabs) {
    for (const field of ['terminalLayoutsByTabId', 'localOnlyScrollbackByTabId'] as const) {
      reader.write(field, tab, { present: false, value: undefined })
    }
    for (const { field, key } of reader.references('tab', tab, 'prior')) {
      if (field === 'terminalPtyIncarnationsByPaneKey') {
        reader.write(field, key, { present: false, value: undefined })
      }
    }
  }
  reader.reconcileField('terminalPtyIncarnationsByPaneKey', {
    kind: 'replacement',
    present: Object.hasOwn(reader.prior, 'terminalPtyIncarnationsByPaneKey')
  })
  const active = reader.field('activeWorktreeId').value
  if (active && isRepoWorktreeId(repoId, active)) {
    reader.replace('activeWorktreeId', { present: true, value: null })
  }
  const key = reader.field('activeWorkspaceKey').value
  const scope = key ? parseWorkspaceKey(key) : null
  if (scope?.type === 'worktree' && isRepoWorktreeId(repoId, scope.worktreeId)) {
    reader.replace('activeWorkspaceKey', { present: true, value: null })
  }
  const members = reader.field('activeWorktreeIdsOnShutdown')
  reader.replace('activeWorktreeIdsOnShutdown', {
    present: true,
    value: members.value?.filter((id) => !isRepoWorktreeId(repoId, id))
  })
}
