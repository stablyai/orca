import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyIpcSpawnState } from './spawn-state'
import { reservePaneSpawn, paneSpawnReservationsByOwnerKey } from '../pane/spawn-reservation'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<void>>(),
  execute: vi.fn(),
  commit: vi.fn()
}))
vi.mock('./spawn-push-target-materialization', () => ({
  triggerPtySpawnPushTargetMaterialization: vi.fn()
}))
vi.mock('./spawn-state', () => ({
  createPtyIpcSpawnState: vi.fn()
}))
vi.mock('./spawn-begin', () => ({ beginPtyIpcSpawn: vi.fn(async () => null) }))
vi.mock('./spawn-preflight', () => ({ preparePtyIpcSpawnPreflight: mocks.prepare }))
vi.mock('./spawn-env', () => ({ assemblePtyIpcSpawnEnv: vi.fn(async () => {}) }))
vi.mock('./spawn-options', () => ({ buildPtyIpcSpawnOptions: vi.fn(async () => null) }))
vi.mock('./spawn-execute', () => ({ executePtyIpcSpawn: mocks.execute }))
vi.mock('./spawn-commit', () => ({ commitPtyIpcSpawn: mocks.commit }))

import { runPtyIpcSpawn } from './spawn-run'
import { createPtyIpcSpawnState } from './spawn-state'

describe('IPC spawn preparation ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    paneSpawnReservationsByOwnerKey.clear()
    mocks.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ;(mocks.prepare as typeof mocks.prepare & { release?: () => void }).release = resolve
        })
    )
    vi.mocked(createPtyIpcSpawnState).mockReturnValue({
      paneSpawnReservationKey: 'owner-key',
      paneSpawnReservation: reservePaneSpawn('owner-key'),
      preSpawnHiddenMarkId: null,
      pendingRegistrationPtyId: null,
      deps: {},
      releaseWorktreeSpawn: vi.fn(),
      finishTerminalInstall: vi.fn()
    } as unknown as PtyIpcSpawnState)
  })
  afterEach(() => {
    paneSpawnReservationsByOwnerKey.clear()
    vi.useRealTimers()
  })

  it('releases the reservation and never enters provider execution after preparation hangs', async () => {
    const result = runPtyIpcSpawn({} as never, { cols: 80, rows: 24 } as never)
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(result).rejects.toThrow('preparation timed out')
    expect(paneSpawnReservationsByOwnerKey.has('owner-key')).toBe(false)
    expect(mocks.execute).not.toHaveBeenCalled()

    ;(mocks.prepare as typeof mocks.prepare & { release?: () => void }).release?.()
    await vi.runAllTicks()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
