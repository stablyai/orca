import { describe, expect, it, vi } from 'vitest'
import { queryWindowsBunPtyProcessIds } from './windows-bun-pty-native'

function writeProcessList(bytes: Uint8Array, pids: number[]): boolean {
  const capacity = (bytes.byteLength - 8) / 8
  const view = new DataView(bytes.buffer)
  view.setUint32(0, pids.length, true)
  view.setUint32(4, Math.min(pids.length, capacity), true)
  pids
    .slice(0, capacity)
    .forEach((pid, index) => view.setBigUint64(8 + index * 8, BigInt(pid), true))
  return pids.length <= capacity
}

describe('Windows Bun job process enumeration', () => {
  it.each([false, true])(
    'grows an incomplete process list when the native call returns %s',
    (result) => {
      const pids = Array.from({ length: 257 }, (_, index) => index + 1)
      const query = vi.fn((bytes: Uint8Array) => writeProcessList(bytes, pids) || result)
      expect(queryWindowsBunPtyProcessIds(query)).toEqual(pids)
      expect(query.mock.calls.map(([bytes]) => (bytes.byteLength - 8) / 8)).toEqual([64, 256, 1024])
    }
  )

  it('does not mistake a failed native query for an empty job', () => {
    const query = vi.fn(() => false)
    expect(queryWindowsBunPtyProcessIds(query)).toBeNull()
    expect(query).toHaveBeenCalledOnce()
  })

  it('returns an empty list only when the native query succeeds', () => {
    expect(queryWindowsBunPtyProcessIds(() => true)).toEqual([])
  })

  it('bounds growth when a process tree exceeds the inventory limit', () => {
    const query = vi.fn((bytes: Uint8Array) => {
      new DataView(bytes.buffer).setUint32(0, 20_000, true)
      return false
    })
    expect(queryWindowsBunPtyProcessIds(query)).toBeNull()
    expect(query).toHaveBeenCalledTimes(5)
  })

  it.each([0, 0x1_0000_0000])(
    'refuses invalid PID %s without reporting partial ownership',
    (pid) => {
      expect(
        queryWindowsBunPtyProcessIds((bytes) => writeProcessList(bytes, [1234, pid]))
      ).toBeNull()
    }
  )
})
