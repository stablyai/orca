import { expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  ptyBindingGenerationOf,
  reconcileTrackedPtyBindingGenerations,
  trackPtyBindingGeneration
} from './pty-binding-generations'

const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))

const leafId = '11111111-1111-4111-8111-111111111111'
const pane = {
  hostId: LOCAL_EXECUTION_HOST_ID,
  tabId: 'tracked-tab',
  leafId
} satisfies Parameters<typeof trackPtyBindingGeneration>[1]
const layout = (ptyId: string): TerminalLayoutSnapshot => ({
  root: { type: 'leaf', leafId },
  activeLeafId: leafId,
  expandedLeafId: null,
  ptyIdsByLeafId: { [leafId]: ptyId }
})
const session = (
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
): WorkspaceSessionState => ({
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId
})

function runtime() {
  return {
    ptyBindingGenerations: new Map<string, number>(),
    ptyBindingGenerationSequence: 0,
    ptyBindingTrackedTabsByHost: new Map()
  }
}

// #42177: A tracked restart cannot add a partition-wide layout scan to snapshot saves.
it.each([
  { owner: 'renderer', main: false },
  { owner: 'main', main: true }
])('reconciles a tracked restart without enumerating unrelated layouts ($owner)', ({ main }) => {
  layoutOwner.main = main
  const state = runtime()
  const original = layout('old')
  const unrelated = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [`unrelated-${index}`, original])
  )
  let enumerated = 0
  const countKeys = (layouts: Record<string, TerminalLayoutSnapshot>) =>
    new Proxy(layouts, {
      ownKeys(target) {
        enumerated += Reflect.ownKeys(target).length
        return Reflect.ownKeys(target)
      }
    })

  const before = session(countKeys({ ...unrelated, [pane.tabId]: original }))
  const after = session(countKeys({ ...unrelated, [pane.tabId]: layout('replacement') }))
  expect(trackPtyBindingGeneration(state, pane)).toBe(1)
  reconcileTrackedPtyBindingGenerations(state, pane.hostId, before, after)
  expect(enumerated).toBe(0)
  expect(ptyBindingGenerationOf(state, pane.hostId, leafId)).toBe(2)
})
