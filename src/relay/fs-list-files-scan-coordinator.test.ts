import { describe, expect, it, vi } from 'vitest'
import {
  LIST_FILES_SUPERSEDED_MESSAGE,
  ListFilesScanCoordinator
} from './fs-list-files-scan-coordinator'
import {
  FileListingCancelledError,
  isFileListingCancellation
} from '../shared/file-listing-cancellation'

type Deferred = {
  promise: Promise<string[]>
  resolve: (files: string[]) => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve!: (files: string[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Scan runner that resolves/rejects on demand and rejects when aborted. */
function controllableScan(): {
  start: (signal: AbortSignal) => Promise<string[]>
  starts: AbortSignal[]
  finish: (files: string[]) => void
} {
  const starts: AbortSignal[] = []
  let current: Deferred | null = null
  return {
    starts,
    start: (signal: AbortSignal) => {
      starts.push(signal)
      const scan = deferred()
      current = scan
      signal.addEventListener(
        'abort',
        () => {
          scan.reject(
            signal.reason instanceof Error ? signal.reason : new FileListingCancelledError()
          )
        },
        { once: true }
      )
      return scan.promise
    },
    finish: (files: string[]) => current?.resolve(files)
  }
}

describe('ListFilesScanCoordinator', () => {
  it('coalesces same-key concurrent requests into one scan', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()

    const first = coordinator.run({ clientId: 1, key: 'a', start: scan.start })
    const second = coordinator.run({ clientId: 1, key: 'a', start: scan.start })

    expect(scan.starts).toHaveLength(1)
    scan.finish(['x.ts'])
    await expect(first).resolves.toEqual(['x.ts'])
    await expect(second).resolves.toEqual(['x.ts'])
  })

  it('supersedes a different-key scan: aborts the old one and rejects it fast', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()

    const first = coordinator.run({ clientId: 1, key: 'workspace-a', start: scan.start })
    const second = coordinator.run({ clientId: 1, key: 'workspace-b', start: scan.start })

    expect(scan.starts).toHaveLength(2)
    expect(scan.starts[0].aborted).toBe(true)
    await expect(first).rejects.toThrow(LIST_FILES_SUPERSEDED_MESSAGE)
    await first.catch((err) => expect(isFileListingCancellation(err)).toBe(true))

    expect(scan.starts[1].aborted).toBe(false)
    scan.finish(['b.ts'])
    await expect(second).resolves.toEqual(['b.ts'])
  })

  it('keeps scans from different clients independent', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scanA = controllableScan()
    const scanB = controllableScan()

    const first = coordinator.run({ clientId: 1, key: 'workspace-a', start: scanA.start })
    const second = coordinator.run({ clientId: 2, key: 'workspace-b', start: scanB.start })

    expect(scanA.starts[0].aborted).toBe(false)
    scanA.finish(['a.ts'])
    scanB.finish(['b.ts'])
    await expect(first).resolves.toEqual(['a.ts'])
    await expect(second).resolves.toEqual(['b.ts'])
  })

  it('aborts the scan when its only requester cancels', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()
    const requester = new AbortController()

    const result = coordinator.run({
      clientId: 1,
      key: 'a',
      signal: requester.signal,
      start: scan.start
    })

    requester.abort()
    expect(scan.starts[0].aborted).toBe(true)
    await expect(result).rejects.toSatisfy(isFileListingCancellation)
  })

  it('keeps a coalesced scan alive while another requester still waits', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()
    const first = new AbortController()
    const second = new AbortController()

    const firstResult = coordinator.run({
      clientId: 1,
      key: 'a',
      signal: first.signal,
      start: scan.start
    })
    const secondResult = coordinator.run({
      clientId: 1,
      key: 'a',
      signal: second.signal,
      start: scan.start
    })

    first.abort()
    expect(scan.starts[0].aborted).toBe(false)
    // The aborting requester observes its own cancellation immediately,
    // while the shared scan keeps running for the sibling.
    await expect(firstResult).rejects.toSatisfy(isFileListingCancellation)

    second.abort()
    expect(scan.starts[0].aborted).toBe(true)
    await expect(secondResult).rejects.toSatisfy(isFileListingCancellation)
  })

  it('rejects an aborted coalesced requester while the sibling still resolves', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()
    const first = new AbortController()

    const firstResult = coordinator.run({
      clientId: 1,
      key: 'a',
      signal: first.signal,
      start: scan.start
    })
    const secondResult = coordinator.run({ clientId: 1, key: 'a', start: scan.start })

    first.abort()
    scan.finish(['kept.ts'])

    await expect(firstResult).rejects.toSatisfy(isFileListingCancellation)
    await expect(secondResult).resolves.toEqual(['kept.ts'])
  })

  it('rejects immediately when the requester is already cancelled', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const start = vi.fn()
    const requester = new AbortController()
    requester.abort()

    await expect(
      coordinator.run({
        clientId: 1,
        key: 'a',
        signal: requester.signal,
        start: start as unknown as (signal: AbortSignal) => Promise<string[]>
      })
    ).rejects.toSatisfy(isFileListingCancellation)
    expect(start).not.toHaveBeenCalled()
  })

  it('starts a fresh scan for the same key after the previous one settled', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()

    const first = coordinator.run({ clientId: 1, key: 'a', start: scan.start })
    scan.finish(['old.ts'])
    await expect(first).resolves.toEqual(['old.ts'])

    const second = coordinator.run({ clientId: 1, key: 'a', start: scan.start })
    expect(scan.starts).toHaveLength(2)
    scan.finish(['new.ts'])
    await expect(second).resolves.toEqual(['new.ts'])
  })

  it('does not join a scan that is already aborted; starts a replacement', async () => {
    const coordinator = new ListFilesScanCoordinator()
    const scan = controllableScan()
    const requester = new AbortController()

    const first = coordinator.run({
      clientId: 1,
      key: 'a',
      signal: requester.signal,
      start: scan.start
    })
    requester.abort()
    await expect(first).rejects.toSatisfy(isFileListingCancellation)

    // The aborted entry may still be in the map until its promise settles;
    // a new same-key request must get a live scan, not the dead one.
    const second = coordinator.run({ clientId: 1, key: 'a', start: scan.start })
    expect(scan.starts).toHaveLength(2)
    expect(scan.starts[1].aborted).toBe(false)
    scan.finish(['fresh.ts'])
    await expect(second).resolves.toEqual(['fresh.ts'])
  })
})
