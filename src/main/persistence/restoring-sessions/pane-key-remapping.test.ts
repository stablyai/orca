import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys
} from './pane-key-remapping'

const STABLE_LEAF_ID = '00000000-0000-4000-8000-000000000001'

describe('remapManuallyUnreadTurnPaneKeys', () => {
  it('promotes legacy pane keys and keeps the newest value on collision', () => {
    const remap = new Map([['tab-1', new Map([['pane:1', STABLE_LEAF_ID]])]])
    const stableKey = makePaneKey('tab-1', STABLE_LEAF_ID)
    const turns = { 'tab-1:pane:1': 42, [stableKey]: 50, 'tab-2:pane:9': 7 }

    const result = remapManuallyUnreadTurnPaneKeys(turns, remap)

    expect(result.changed).toBe(true)
    expect(result.turns).toEqual({ [stableKey]: 50, 'tab-2:pane:9': 7 })
    expect(remapActivityClearedAtPaneKeys(turns, remap).cutoffs).toEqual(result.turns)
  })
})
