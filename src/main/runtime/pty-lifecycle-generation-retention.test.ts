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
})
