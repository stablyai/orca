import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  SESSION_FIELDS_TRANSFERRED,
  type TransferredSessionField
} from './profile-project-session-field-disposition'
import { mergeWorkspaceSessions } from './profile-project-session-state'

/**
 * Why: `mergeWorkspaceSessions` is the apply side of a project transfer and is a hand-written
 * field list. A field classified as transferable but missing from that list is dropped silently --
 * `...base` still supplies a value, so the merged session looks well-formed and the loss only
 * shows up as the user's tabs, layouts, or browser workspaces missing after the transfer.
 * Every transferable field is probed here so the omission fails a test instead.
 */

const PROBE_KEY = 'orca-merge-probe-owner'
const PROBE_TEXT = 'orca-merge-probe-value'
const PROBE_NUMBER = 41

type MergeProbeKind = 'record' | 'numericRecord' | 'array' | 'scalar'

// Adding a transferable session field is a compile error until it is probed here.
const MERGE_PROBE_KIND = {
  activeWorkspaceKey: 'scalar',
  activeWorktreeId: 'scalar',
  activeWorktreeIdsOnShutdown: 'array',
  tabsByWorktree: 'record',
  terminalLayoutsByTabId: 'record',
  openFilesByWorktree: 'record',
  activeFileIdByWorktree: 'record',
  browserTabsByWorktree: 'record',
  browserPagesByWorkspace: 'record',
  activeBrowserTabIdByWorktree: 'record',
  activeTabTypeByWorktree: 'record',
  activeTabIdByWorktree: 'record',
  unifiedTabs: 'record',
  tabGroups: 'record',
  tabGroupLayouts: 'record',
  activeGroupIdByWorktree: 'record',
  lastVisitedAtByWorktreeId: 'numericRecord',
  defaultTerminalTabsAppliedByWorktreeId: 'record',
  terminalPtyIncarnationsByPaneKey: 'record',
  terminalTopologyRevisionByRepoId: 'numericRecord',
  terminalSurfaceTombstonesByPaneKey: 'record'
} as const satisfies Record<TransferredSessionField, MergeProbeKind>

function probeValue(kind: MergeProbeKind): unknown {
  switch (kind) {
    case 'record':
      return { [PROBE_KEY]: PROBE_TEXT }
    case 'numericRecord':
      return { [PROBE_KEY]: PROBE_NUMBER }
    case 'array':
      return [PROBE_TEXT]
    case 'scalar':
      return PROBE_TEXT
  }
}

function readProbe(merged: WorkspaceSessionState, field: TransferredSessionField): unknown {
  const value = (merged as Record<string, unknown>)[field]
  const kind = MERGE_PROBE_KIND[field]
  if (kind === 'array') {
    return Array.isArray(value) ? value.find((entry) => entry === PROBE_TEXT) : undefined
  }
  if (kind === 'scalar') {
    return value
  }
  return (value as Record<string, unknown> | undefined)?.[PROBE_KEY]
}

function expectedProbe(field: TransferredSessionField): unknown {
  return MERGE_PROBE_KIND[field] === 'numericRecord' ? PROBE_NUMBER : PROBE_TEXT
}

describe('mergeWorkspaceSessions transferable field coverage', () => {
  it('probes every field the transfer census says can arrive', () => {
    expect(Object.keys(MERGE_PROBE_KIND).sort()).toEqual([...SESSION_FIELDS_TRANSFERRED].sort())
  })

  it.each(SESSION_FIELDS_TRANSFERRED)('carries incoming %s into the merged session', (field) => {
    const incoming = {
      ...getDefaultWorkspaceSession(),
      [field]: probeValue(MERGE_PROBE_KIND[field])
    } as WorkspaceSessionState

    const merged = mergeWorkspaceSessions(getDefaultWorkspaceSession(), incoming)

    expect(readProbe(merged, field)).toEqual(expectedProbe(field))
  })

  it('keeps the base value for a field the transfer census never emits', () => {
    const base = { ...getDefaultWorkspaceSession(), activeRepoId: 'base-repo' }
    const incoming = { ...getDefaultWorkspaceSession(), activeRepoId: 'incoming-repo' }

    expect(mergeWorkspaceSessions(base, incoming).activeRepoId).toBe('base-repo')
  })
})
