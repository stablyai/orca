import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

describe('per-PTY lifecycle generation retention (leak regression)', () => {
  type Internals = { ptyLifecycleGenerationById: Map<string, number> }

  it('retains no lifecycle generation after a spawn/exit cycle', () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runtime owns this private generation map; the leak regression inspects its size.
    const internals = runtime as unknown as Internals
    for (let index = 0; index < 50; index += 1) {
      const ptyId = `pty-${index}`
      runtime.onPtySpawned(ptyId)
      runtime.onPtyExit(ptyId, 0)
    }
    expect(internals.ptyLifecycleGenerationById.size).toBe(0)
  })

  it('never hands a respawn a generation a pre-exit capture could still match', () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runtime owns these private generation members; the regression inspects their values across lifecycle events.
    const internals = runtime as unknown as Internals & {
      getPtyLifecycleGeneration: (ptyId: string) => number
    }
    runtime.onPtySpawned('pty-1')
    const beforeExit = internals.getPtyLifecycleGeneration('pty-1')
    runtime.onPtyExit('pty-1', 0)

    runtime.onPtySpawned('pty-1')
    const afterRespawn = internals.getPtyLifecycleGeneration('pty-1')

    expect(afterRespawn).toBeGreaterThan(beforeExit)
    // Stable once re-minted, so a post-respawn capture keeps matching itself.
    expect(internals.getPtyLifecycleGeneration('pty-1')).toBe(afterRespawn)
  })
})
