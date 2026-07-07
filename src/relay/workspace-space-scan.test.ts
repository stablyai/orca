import { describe, expect, it, vi, beforeEach } from 'vitest'

const { lstatMock, readdirMock, execFileMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readdirMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readdir: readdirMock
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'

const context = { clientId: 0, isStale: () => false } as never

const dirStat = { isDirectory: () => true, isSymbolicLink: () => false, size: 100 }
const fileStat = { isDirectory: () => false, isSymbolicLink: () => false, size: 10 }
const dirEntry = (name: string) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })

describe('scanWorkspaceSpaceDirectory node-walk budget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Why: force the node fallback path by making the `du` fast path fail.
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('du unavailable'))
      }
    )
  })

  it('terminates on an unbounded tree and caps how many directories it reads', async () => {
    // Every directory reports two more subdirectories forever. Without the
    // budget this recurses without end; the cap must stop it.
    lstatMock.mockResolvedValue(dirStat)
    readdirMock.mockResolvedValue([dirEntry('a'), dirEntry('b')])

    const result = await scanWorkspaceSpaceDirectory('/remote/huge', context, {
      maxNodeScanEntries: 20
    })

    // It returned at all (did not recurse forever), read a bounded number of
    // directories proportional to the cap, and flagged the un-walked subtree as
    // skipped. The generous bound avoids flakiness from limiter concurrency
    // while still proving the walk is bounded (an unbounded walk never returns).
    expect(readdirMock.mock.calls.length).toBeLessThan(200)
    expect(result.skippedEntryCount).toBeGreaterThan(0)
  })

  it('scans a small tree fully without spuriously flagging it partial', async () => {
    // root/ -> [file.txt, sub/]; sub/ -> [nested.txt]
    lstatMock.mockImplementation(async (p: string) => (p.endsWith('.txt') ? fileStat : dirStat))
    readdirMock.mockImplementation(async (p: string) => {
      if (p === '/remote/small') {
        return [
          { name: 'file.txt', isDirectory: () => false, isSymbolicLink: () => false },
          dirEntry('sub')
        ]
      }
      if (p.endsWith('/sub')) {
        return [{ name: 'nested.txt', isDirectory: () => false, isSymbolicLink: () => false }]
      }
      return []
    })

    const result = await scanWorkspaceSpaceDirectory('/remote/small', context, {
      maxNodeScanEntries: 20
    })

    expect(result.skippedEntryCount).toBe(0)
    // root(100) + file.txt(10) + sub(100) + nested.txt(10)
    expect(result.sizeBytes).toBe(220)
  })
})
