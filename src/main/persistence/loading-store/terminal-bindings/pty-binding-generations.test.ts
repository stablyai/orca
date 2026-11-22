import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  ptyBindingGenerationOf,
  reconcileTrackedPtyBindingGenerations,
  trackPtyBindingGeneration
} from './pty-binding-generations'

it('expires the previous restart coordinate when a leaf moves to a different tab', () => {
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
  const runtime = { ptyBindingGenerations: new Map(), ptyBindingTrackedTabsByHost: new Map() }
  expect(trackPtyBindingGeneration(runtime, { hostId, leafId, tabId: 'original' })).toBe(1)

  reconcileTrackedPtyBindingGenerations(runtime, hostId, before, {
    ...before,
    terminalLayoutsByTabId: { moved: layout }
  })

  expect(ptyBindingGenerationOf(runtime, hostId, leafId)).toBeUndefined()
  expect(trackPtyBindingGeneration(runtime, { hostId, leafId, tabId: 'moved' })).toBe(2)
})
