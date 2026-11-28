/**
 * Issues #8533 and #8584 — default keybinding collisions.
 * Run: pnpm exec vitest run docs/bug-reproductions/scripts/repro-shortcut-conflicts.test.ts
 */
import { describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../../src/shared/keybindings'

describe('issue #8533 Cmd+Shift+E collision on darwin', () => {
  it('tab.newSimulator and sidebar.explorer.toggle share Mod+Shift+E on darwin', () => {
    const simulator = getEffectiveKeybindingsForAction('tab.newSimulator', 'darwin')
    const explorer = getEffectiveKeybindingsForAction('sidebar.explorer.toggle', 'darwin')
    expect(simulator).toContain('Mod+Shift+E')
    expect(explorer).toContain('Mod+Shift+E')
    // Document that linux/win32 do not ship the simulator default (no collision there).
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'win32')).toEqual([])
  })
})

describe('issue #8584 Mod+0 collision', () => {
  it('zoom.reset and sidebar.focusWorktreeList both default to Mod+0', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const zoom = getEffectiveKeybindingsForAction('zoom.reset', platform)
      const focus = getEffectiveKeybindingsForAction('sidebar.focusWorktreeList', platform)
      expect(zoom).toContain('Mod+0')
      expect(focus).toContain('Mod+0')
    }
  })
})
