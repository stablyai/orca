import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerSnapshotResult } from '../../shared/computer-use-runtime-types'
import { ComputerTreeBaselines } from './computer-snapshot-tree-diff'

const KEYS = Array.from({ length: 20 }, (_, digit) => `Key ${digit}`)

function read(id: string, display: string): ComputerSnapshotResult {
  return {
    snapshot: {
      id,
      app: { name: 'Calculator', bundleId: 'com.apple.calculator', pid: 42 },
      window: { id: 7, index: 0, title: 'Calculator', width: 200, height: 300 },
      coordinateSpace: 'window',
      treeText: [
        '0 window Calculator',
        `\t1 text ${display}`,
        ...KEYS.map((key, index) => `\t${index + 2} button ${key}`)
      ].join('\n'),
      elementCount: KEYS.length + 2,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}

describe('ComputerTreeBaselines', () => {
  it('diffs against the read before a batch, not against its intermediate steps', () => {
    const baselines = new ComputerTreeBaselines()
    const target = { app: 'Calculator', session: 's1' }
    baselines.apply(target, read('before', '0'))
    baselines.apply({ ...target, keepTreeBaseline: true }, read('step-1', '7'))
    baselines.apply({ ...target, keepTreeBaseline: true }, read('step-2', '56'))

    const after = baselines.apply({ ...target, treeDiff: true }, read('after', '56'))

    expect(after.snapshot.treeDiff).toEqual({
      baseSnapshotId: 'before',
      changed: 1,
      added: 0,
      removed: 0
    })
    expect(after.snapshot.treeText).toContain('~ \t1 text 56')
  })

  describe('baseline lifetime', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps the pre-batch baseline for a batch that outlives the normal lifetime', () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const baselines = new ComputerTreeBaselines()
      const target = { app: 'Calculator', session: 's1' }
      baselines.apply(target, read('before', '0'))
      vi.setSystemTime(130_000)

      const stale = baselines.apply({ ...target, treeDiff: true }, read('late', '7'))
      expect(stale.snapshot.treeDiff).toBeUndefined()

      vi.setSystemTime(0)
      const fresh = new ComputerTreeBaselines()
      fresh.apply(target, read('before', '0'))
      vi.setSystemTime(130_000)
      const after = fresh.apply(
        { ...target, treeDiff: true, treeBaselineGraceMs: 130_000 },
        read('after', '7')
      )
      expect(after.snapshot.treeDiff?.baseSnapshotId).toBe('before')
    })
  })
})
