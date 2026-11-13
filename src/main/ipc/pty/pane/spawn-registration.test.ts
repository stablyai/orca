import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { TerminalIntentionalStops } from '../../../runtime/terminal/stop/terminal-intentional-stops'
import { admitPtySpawnOwnership, discardUnpersistedPtySpawn } from './spawn-registration'

type MarkUnverifiable = (ptyId: string, reason: string) => void
const PTY_ID = 'unpersisted-spawn'
const result: PtySpawnResult = { id: PTY_ID, incarnationId: 'inc-1' }

function providerWhoseShutdown(shutdown: () => Promise<void>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discard calls only shutdown.
  return { shutdown } as unknown as IPtyProvider
}

describe('discarding a spawn whose binding failed to save', () => {
  afterEach(() => {
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  function discard(
    shutdown: () => Promise<void>,
    runtime: {
      markPtyLivenessUnverifiable: Mock<MarkUnverifiable>
      intentionalPtyStops?: TerminalIntentionalStops
    } = { markPtyLivenessUnverifiable: vi.fn<MarkUnverifiable>() }
  ): Promise<typeof runtime> {
    admitPtySpawnOwnership(undefined, result)
    return discardUnpersistedPtySpawn(providerWhoseShutdown(shutdown), result, runtime).then(
      () => runtime
    )
  }

  // Unmarked cleanup exits once looked like agent completion and removed the user's tab (QA687).
  it('retires the PTY once the host acknowledged the shutdown, as a stop that keeps the tab', async () => {
    const intentionalPtyStops = new TerminalIntentionalStops()
    const runtime = await discard(() => Promise.resolve(), {
      markPtyLivenessUnverifiable: vi.fn<MarkUnverifiable>(),
      intentionalPtyStops
    })

    expect(ptyOwnership.has(PTY_ID)).toBe(false)
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
    expect(intentionalPtyStops.claimExit(PTY_ID, 'inc-1')).toEqual(['replaced'])
  })
})
