import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys
} from './pane-key-remapping'

const STABLE_LEAF_ID = '00000000-0000-4000-8000-000000000001'

describe('remapManuallyUnreadTurnPaneKeys', () => {
  it('promotes legacy pane keys to the restored stable leaf like clear-completed cutoffs', () => {
    const remap = new Map([['tab-1', new Map([['pane:1', STABLE_LEAF_ID]])]])
    const turns = { 'tab-1:pane:1': 42, 'tab-2:pane:9': 7 }

    const result = remapManuallyUnreadTurnPaneKeys(turns, remap)

    expect(result.changed).toBe(true)
    expect(result.turns).toEqual({ [makePaneKey('tab-1', STABLE_LEAF_ID)]: 42, 'tab-2:pane:9': 7 })
    // Same remap contract as the cutoffs so the two never drift after a session restore.
    expect(remapActivityClearedAtPaneKeys(turns, remap).cutoffs).toEqual(result.turns)
  })

  it('reports no change for empty or already-stable records', () => {
    const remap = new Map([['tab-1', new Map([['pane:1', STABLE_LEAF_ID]])]])
    expect(remapManuallyUnreadTurnPaneKeys(undefined, remap).changed).toBe(false)
    expect(remapManuallyUnreadTurnPaneKeys({}, remap).changed).toBe(false)
    const stable = { [makePaneKey('tab-1', STABLE_LEAF_ID)]: 1 }
    expect(remapManuallyUnreadTurnPaneKeys(stable, remap)).toEqual({
      turns: stable,
      changed: false
    })
  })
})
