import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

const PTY_ID = 'pty-agent'
const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function runtimeWithSpawnedPty(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: 'tab-source', leafId: LEAF_ID })
  return runtime
}

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('restampMovedPtySurface', () => {
  it('re-points the PTY record at the tab and pane key it moved to', () => {
    const runtime = runtimeWithSpawnedPty()
    const toPaneKey = makePaneKey('tab-target', LEAF_ID)

    runtime.restampMovedPtySurface(PTY_ID, 'tab-target', toPaneKey)

    expect(runtime['ptysById'].get(PTY_ID)).toMatchObject({
      tabId: 'tab-target',
      paneKey: toPaneKey
    })
  })

  it('ignores a PTY the runtime does not know', () => {
    const runtime = runtimeWithSpawnedPty()

    runtime.restampMovedPtySurface('pty-unknown', 'tab-target', makePaneKey('tab-target', LEAF_ID))

    expect(runtime['ptysById'].get('pty-unknown')).toBeUndefined()
    expect(runtime['ptysById'].get(PTY_ID)).toMatchObject({ tabId: 'tab-source' })
  })
})

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('restampMovedPtySurface in layout-owner builds', () => {
  it("leaves no pane claim on the record, because main's layout answers for the moved pane", () => {
    const runtime = runtimeWithSpawnedPty()

    runtime.restampMovedPtySurface(PTY_ID, 'tab-target', makePaneKey('tab-target', LEAF_ID))

    const record = runtime['ptysById'].get(PTY_ID)
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('tabId')
    expect(record).not.toHaveProperty('paneKey')
    expect(record).not.toHaveProperty('surfaceRecordedAtGraphSequence')
  })
})
