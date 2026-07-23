import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOME_SNAPSHOT_MAX_SERIALIZED_BYTES,
  loadHomeSnapshot,
  resetHomeSnapshotCacheForTests,
  saveHomeSnapshot,
  type HomeSnapshot
} from './home-snapshot-cache'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

function snapshotWithSerializedBytes(serializedBytes: number): HomeSnapshot {
  const base = {
    worktreeInfo: {},
    accountsByHost: {},
    savedAt: 1,
    padding: ''
  }
  const baseBytes = JSON.stringify(base).length
  return {
    ...base,
    padding: 'x'.repeat(serializedBytes - baseBytes)
  } as unknown as HomeSnapshot
}

describe('home snapshot cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHomeSnapshotCacheForTests()
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    resetHomeSnapshotCacheForTests()
    vi.useRealTimers()
  })

  it('persists and reloads normal snapshots unchanged', async () => {
    const snapshot = snapshotWithSerializedBytes(128)
    saveHomeSnapshot(snapshot)
    await vi.advanceTimersByTimeAsync(250)

    const raw = vi.mocked(AsyncStorage.setItem).mock.calls[0]?.[1]
    expect(raw).toBe(JSON.stringify(snapshot))

    resetHomeSnapshotCacheForTests()
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(raw ?? null)
    await expect(loadHomeSnapshot()).resolves.toEqual(snapshot)
  })

  it('accepts the exact serialized-byte cap and rejects one byte over', async () => {
    const exact = snapshotWithSerializedBytes(HOME_SNAPSHOT_MAX_SERIALIZED_BYTES)
    saveHomeSnapshot(exact)
    await vi.advanceTimersByTimeAsync(250)
    expect(AsyncStorage.setItem).toHaveBeenCalledOnce()
    expect(vi.mocked(AsyncStorage.setItem).mock.calls[0]?.[1]).toHaveLength(
      HOME_SNAPSHOT_MAX_SERIALIZED_BYTES
    )

    vi.mocked(AsyncStorage.setItem).mockClear()
    saveHomeSnapshot(snapshotWithSerializedBytes(HOME_SNAPSHOT_MAX_SERIALIZED_BYTES + 1))
    await vi.advanceTimersByTimeAsync(250)
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })

  it('rejects an oversized durable payload before JSON parsing', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      `"${'x'.repeat(HOME_SNAPSHOT_MAX_SERIALIZED_BYTES)}"`
    )

    await expect(loadHomeSnapshot()).resolves.toBeNull()
  })
})
