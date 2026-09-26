import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { withHostBindingTabs } from './recovery-import-plan'
import {
  descriptor,
  fixture,
  SESSION_ID,
  SOURCE_LEAF,
  SOURCE_TAB
} from './recovery-import.test-fixture'

const OTHER_SESSION_ID = '6a2d2d4f-2222-4333-8444-555566667777'

describe('withHostBindingTabs', () => {
  it('restores a bound leaf that a stale client view dropped from a shared tab', () => {
    const d = descriptor()
    const staleLayout = {
      root: { type: 'leaf' as const, leafId: 'leaf-b' },
      activeLeafId: 'leaf-b',
      expandedLeafId: null
    }
    const view = {
      ...d.layout,
      terminalLayouts: { ...d.layout.terminalLayouts, [SOURCE_TAB]: staleLayout }
    }
    const merged = withHostBindingTabs(view, d.layout, d.bindings)
    expect(d.bindings[0].sourceLeafId).toBe(SOURCE_LEAF)
    expect(merged.terminalLayouts[SOURCE_TAB]).toEqual(d.layout.terminalLayouts[SOURCE_TAB])
  })
})

describe('planRecoveryBindings', () => {
  it('gives each binding from one source pane its own placement, the live one keeping the pane', async () => {
    const f = fixture()
    const d = descriptor()
    const live = d.bindings[0]
    const older = {
      ...live,
      providerSession: { key: 'session_id' as const, id: OTHER_SESSION_ID },
      liveness: 'sleeping' as const,
      updatedAt: 5
    }
    d.bindings = [older, live]

    const result = await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: d, checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )

    const paneKeys = Object.keys(f.getSession().sleepingAgentSessionsByPaneKey ?? {})
    expect(paneKeys).toHaveLength(2)
    expect(result.bindings.map((b) => b.localPaneKey).sort()).toEqual([...paneKeys].sort())
    expect(result.bindings.find((b) => b.binding.id === SESSION_ID)?.localPaneKey).toBe(
      makePaneKey(result.idMap.tabs[SOURCE_TAB]!, result.idMap.leaves[SOURCE_LEAF]!)
    )
  })
})
