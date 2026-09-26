import { describe, expect, it } from 'vitest'
import { withHostBindingTabs } from './recovery-import-plan'
import { descriptor, SOURCE_LEAF, SOURCE_TAB } from './recovery-import.test-fixture'

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
