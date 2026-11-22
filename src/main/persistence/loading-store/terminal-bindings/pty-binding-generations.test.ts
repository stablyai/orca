import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  ptyBindingGenerationOf,
  reconcileTrackedPtyBindingGenerations,
  trackPtyBindingGeneration
} from './pty-binding-generations'

const hostId = LOCAL_EXECUTION_HOST_ID
const leafId = '11111111-1111-4111-8111-111111111111'
const layout: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId },
  activeLeafId: leafId,
  expandedLeafId: null,
  ptyIdsByLeafId: { [leafId]: 'incumbent-pty' }
}
const before: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: { original: layout }
}

it('expires the previous restart coordinate when a leaf moves to a different tab', () => {
  const runtime = { ptyBindingGenerations: new Map(), ptyBindingTrackedTabsByHost: new Map() }
  expect(trackPtyBindingGeneration(runtime, { hostId, leafId, tabId: 'original' })).toBe(1)

  reconcileTrackedPtyBindingGenerations(runtime, hostId, before, {
    ...before,
    terminalLayoutsByTabId: { moved: layout }
  })

  expect(ptyBindingGenerationOf(runtime, hostId, leafId)).toBeUndefined()
  expect(trackPtyBindingGeneration(runtime, { hostId, leafId, tabId: 'moved' })).toBe(2)
})

it('expires an enrolled restart across main-owned incarnation changes with a stable PTY and layout', () => {
  const runtime = { ptyBindingGenerations: new Map(), ptyBindingTrackedTabsByHost: new Map() }
  const paneKey = `original:${leafId}`
  const original = { ...before, terminalPtyIncarnationsByPaneKey: { [paneKey]: 'incumbent' } }
  const replacement = {
    ...original,
    terminalPtyIncarnationsByPaneKey: { [paneKey]: 'replacement' }
  }
  expect(trackPtyBindingGeneration(runtime, { hostId, leafId, tabId: 'original' })).toBe(1)

  reconcileTrackedPtyBindingGenerations(runtime, hostId, original, replacement, true)
  reconcileTrackedPtyBindingGenerations(runtime, hostId, replacement, original, true)

  expect(ptyBindingGenerationOf(runtime, hostId, leafId)).toBe(3)
})
