import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { IPtyProvider, PtySpawnResult } from '../../../providers/pty-provider-contract'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { admitPtySpawnOwnership, discardUnpersistedPtySpawn } from './spawn-registration'

const PTY_ID = 'unpersisted-spawn'
const result: PtySpawnResult = { id: PTY_ID, incarnationId: 'inc-1' }

function providerWhoseShutdown(shutdown: () => Promise<void>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discard calls only shutdown.
  return { shutdown } as unknown as IPtyProvider
}

// The commit records ownership at its start, before the save whose failure leads here.
describe('discarding a spawn whose binding failed to save', () => {
  afterEach(() => {
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  function discard(
    shutdown: () => Promise<void>,
    runtime = { markPtyLivenessUnverifiable: vi.fn() }
  ): Promise<typeof runtime> {
    admitPtySpawnOwnership(undefined, result)
    return discardUnpersistedPtySpawn(providerWhoseShutdown(shutdown), result, runtime).then(
      () => runtime
    )
  }

  it('keeps tracking the PTY and reads unverifiable when the shutdown fails', async () => {
    const runtime = await discard(() => Promise.reject(new Error('shutdown timed out')))

    expect(ptyOwnership.get(PTY_ID)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-1')
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining('shutdown timed out')
    )
  })

  it('retires the PTY once the host acknowledged the shutdown', async () => {
    const runtime = await discard(() => Promise.resolve())

    expect(ptyOwnership.has(PTY_ID)).toBe(false)
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })

  it('leaves a same-id replacement that arrived during the shutdown alone', async () => {
    await discard(async () => {
      ptyOwnership.set(PTY_ID, 'ssh:successor')
      ptyIncarnationById.set(PTY_ID, 'inc-2')
    })

    expect(ptyOwnership.get(PTY_ID)).toBe('ssh:successor')
    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-2')
  })

  it('keeps an exit observed during a shutdown whose reply was lost', async () => {
    const runtime = await discard(async () => {
      // The provider's exit listener retires the PTY before the RPC rejects.
      ptyOwnership.delete(PTY_ID)
      ptyIncarnationById.delete(PTY_ID)
      throw new Error('shutdown response lost')
    })

    expect(ptyOwnership.has(PTY_ID)).toBe(false)
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })

  it('does not mark a same-id replacement unverifiable when the predecessor shutdown fails', async () => {
    const runtime = await discard(async () => {
      ptyIncarnationById.set(PTY_ID, 'inc-2')
      throw new Error('shutdown response lost')
    })

    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-2')
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })
})
