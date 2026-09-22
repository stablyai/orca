import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reapDescendantTree } from './pty-descendant-tree-reap'
import type { ProcessTableCapture, ProcessTableRow } from './pty-descendant-termination'

function row(
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = 'Mon Jan  1 00:00:00 2024'
): ProcessTableRow {
  return { pid, ppid, pgid, startedAt }
}

function table(
  rows: ProcessTableRow[],
  capturedAtMs = Date.parse('2024-01-01T00:00:01Z')
): ProcessTableCapture {
  return { rows, capturedAtMs }
}

describe('reapDescendantTree', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('returns exited when the POSIX root has no descendants', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const killRoot = vi.fn()
    const readTable = vi.fn(async () => table([row(10, 1, 10)]))

    await expect(
      reapDescendantTree(10, killRoot, { readTable, verifyMs: 50, graceMs: 10 })
    ).resolves.toBe('exited')
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('returns unverifiable when the POSIX table omits the root row', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const killRoot = vi.fn()
    // Root 10 is absent. A row still parented on that pid is a reuse coincidence,
    // not a descendant this walk is allowed to treat as evidence.
    const readTable = vi.fn(async () => table([row(20, 1, 20), row(21, 10, 21)]))

    await expect(
      reapDescendantTree(10, killRoot, { readTable, verifyMs: 50, graceMs: 10, timeoutMs: 20 })
    ).resolves.toBe('unverifiable')
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('returns unverifiable when the POSIX process table cannot be read', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const killRoot = vi.fn()
    const readTable = vi.fn(async () => {
      throw new Error('ps failed')
    })

    await expect(
      reapDescendantTree(10, killRoot, { readTable, timeoutMs: 20, verifyMs: 50 })
    ).resolves.toBe('unverifiable')
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('returns live when a snapshotted descendant survives SIGTERM and SIGKILL', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const killRoot = vi.fn()
    const survivor = row(20, 10, 20, 'Mon Jan  1 00:00:00 2024')
    const readTable = vi.fn(async () => table([row(10, 1, 10), survivor]))
    const sendSignal = vi.fn()

    await expect(
      reapDescendantTree(10, killRoot, {
        readTable,
        sendSignal,
        graceMs: 10,
        verifyMs: 40,
        timeoutMs: 20
      })
    ).resolves.toBe('live')
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal).toHaveBeenCalled()
  })

  it('returns exited after a snapshotted descendant disappears', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const killRoot = vi.fn()
    const child = row(20, 10, 20, 'Mon Jan  1 00:00:00 2024')
    let reads = 0
    const readTable = vi.fn(async () => {
      reads += 1
      // First capture includes the child; later polls show only the root (or nothing).
      if (reads === 1) {
        return table([row(10, 1, 10), child])
      }
      return table([row(10, 1, 10)])
    })

    await expect(
      reapDescendantTree(10, killRoot, {
        readTable,
        sendSignal: vi.fn(),
        graceMs: 10,
        verifyMs: 200,
        timeoutMs: 50
      })
    ).resolves.toBe('exited')
    expect(killRoot).toHaveBeenCalledOnce()
  })
})
