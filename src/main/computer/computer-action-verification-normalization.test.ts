import { describe, expect, it } from 'vitest'
import type { ComputerActionResult } from '../../shared/runtime-types'
import { normalizeComputerActionResult } from './computer-action-verification-normalization'

describe('normalizeComputerActionResult', () => {
  it('marks accessibility actions without a post-state assertion as unverified', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Finder', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 1,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: { path: 'accessibility', actionName: 'click' }
    }

    expect(normalizeComputerActionResult(result).action?.verification).toEqual({
      state: 'unverified',
      reason: 'accessibility_action_unasserted'
    })
  })

  it('keeps the AXError the provider reported for an action that may still have run', () => {
    const verification = {
      state: 'unverified' as const,
      reason: 'accessibility_action_unasserted' as const,
      axError: -25204
    }
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Documents', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 1,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: { path: 'accessibility', actionName: 'AXOpen', verification }
    }

    expect(normalizeComputerActionResult(result).action?.verification).toEqual(verification)
  })
})
