import { describe, expect, it, vi } from 'vitest'
import type { FileStat, FileUploadSession, IFilesystemProvider } from '../providers/types'
import {
  IDENTITY_OUTSTANDING_LIMIT,
  IDENTITY_READ_DEADLINE_MS,
  ROLLBACK_LSTAT_TIMEOUT_MS,
  SshImportCreatedLedger
} from './filesystem-import-ssh-rollback'

function createProvider(lstat: (path: string) => Promise<FileStat>): IFilesystemProvider {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeFileBase64: vi.fn(),
    writeFileBase64Chunk: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(lstat),
    deletePath: vi.fn(),
    createFile: vi.fn(),
    createDir: vi.fn(),
    createDirNoClobber: vi.fn(),
    rename: vi.fn(),
    renameNoClobber: vi.fn(),
    copy: vi.fn(),
    realpath: vi.fn(),
    search: vi.fn(),
    listFiles: vi.fn(),
    watch: vi.fn()
  }
}

const session: FileUploadSession = { uploadFile: vi.fn(), close: vi.fn() }

describe('SshImportCreatedLedger identity reads', () => {
  it('keeps at most 16 identity reads in flight and still completes every one', async () => {
    let inFlight = 0
    let peak = 0
    const pending: (() => void)[] = []
    const provider = createProvider(async (path) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => pending.push(resolve))
      inFlight -= 1
      return { size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length }
    })
    const ledger = new SshImportCreatedLedger(provider, session)

    const entries = Array.from({ length: 40 }, (_, index) =>
      ledger.record(`/r/f${index}`, 'file', 0)
    )
    await vi.waitFor(() => expect(pending).toHaveLength(16))
    // Why: releasing reads one at a time lets each freed slot admit the next queued read.
    while (pending.length > 0) {
      pending.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    }

    const identities = await Promise.all(entries.map((entry) => entry.identity))
    expect(peak).toBe(16)
    expect(identities.every((identity) => identity !== null)).toBe(true)
  })

  it('skips an identity read that would start past the deadline', async () => {
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const pending: (() => void)[] = []
    const provider = createProvider(async (path) => {
      await new Promise<void>((resolve) => pending.push(resolve))
      return { size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length }
    })
    const ledger = new SshImportCreatedLedger(provider, session)
    try {
      const entries = Array.from({ length: 20 }, (_, index) =>
        ledger.record(`/r/f${index}`, 'file', 0)
      )
      await vi.waitFor(() => expect(pending).toHaveLength(16))
      // Why: the queued four would read long after their create, when a swap may already be there.
      clock = IDENTITY_READ_DEADLINE_MS + 1
      while (pending.length > 0) {
        pending.shift()?.()
        await new Promise((resolve) => setImmediate(resolve))
      }

      const identities = await Promise.all(entries.map((entry) => entry.identity))
      expect(identities.every((identity) => identity === null)).toBe(true)
      expect(provider.lstat).toHaveBeenCalledTimes(16)
    } finally {
      now.mockRestore()
    }
  })

  it('drops an identity whose reply arrives past the deadline, since the remote read may have run late', async () => {
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let release = (): void => {}
    const provider = createProvider(async (path) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length }
    })
    const ledger = new SshImportCreatedLedger(provider, session)
    try {
      const entry = ledger.record('/r/f', 'file', 0)
      await vi.waitFor(() => expect(provider.lstat).toHaveBeenCalledTimes(1))
      clock = IDENTITY_READ_DEADLINE_MS + 1
      release()

      await expect(entry.identity).resolves.toBeNull()
    } finally {
      now.mockRestore()
    }
  })

  it('keeps a file whose identity read never replies and still rolls back the rest', async () => {
    vi.useFakeTimers()
    try {
      let stuckReads = 0
      const provider = createProvider((path) => {
        if (path === '/r/stuck' && stuckReads++ === 0) {
          return new Promise<FileStat>(() => {})
        }
        return Promise.resolve({ size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length })
      })
      const removeCreatedEntry = vi.fn(async () => {})
      const ledger = new SshImportCreatedLedger(provider, { ...session, removeCreatedEntry })
      ledger.record('/r/ok', 'file', 0)
      ledger.record('/r/stuck', 'file', 0)
      let rolledBack = false
      void ledger.rollback().then(() => {
        rolledBack = true
      })

      await vi.advanceTimersByTimeAsync(IDENTITY_READ_DEADLINE_MS - 1)
      expect(rolledBack).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(rolledBack).toBe(true)
      expect(removeCreatedEntry).toHaveBeenCalledTimes(1)
      expect(removeCreatedEntry).toHaveBeenCalledWith('/r/ok', 'file')
      expect(ledger.remaining).toEqual(['/r/stuck'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('frees the slots of stalled reads at the deadline so later files still get an identity', async () => {
    vi.useFakeTimers()
    try {
      const provider = createProvider((path) =>
        path.startsWith('/r/stalled')
          ? new Promise<FileStat>(() => {})
          : Promise.resolve({ size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length })
      )
      const ledger = new SshImportCreatedLedger(provider, session)
      for (let index = 0; index < 16; index += 1) {
        ledger.record(`/r/stalled${index}`, 'file', 0)
      }
      await vi.advanceTimersByTimeAsync(IDENTITY_READ_DEADLINE_MS + 1)

      const next = ledger.record('/r/next', 'file', 0)
      await vi.advanceTimersByTimeAsync(0)
      await expect(next.identity).resolves.toMatchObject({ ino: '/r/next'.length })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a file whose rollback check never replies and still rolls back the rest', async () => {
    vi.useFakeTimers()
    try {
      const reads = new Map<string, number>()
      const provider = createProvider((path) => {
        const count = (reads.get(path) ?? 0) + 1
        reads.set(path, count)
        if (path === '/r/stuck' && count === 2) {
          return new Promise<FileStat>(() => {})
        }
        return Promise.resolve({ size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length })
      })
      const removeCreatedEntry = vi.fn(async () => {})
      const ledger = new SshImportCreatedLedger(provider, { ...session, removeCreatedEntry })
      // Why: rollback runs newest first, so /r/ok is checked before the stall trips the breaker.
      ledger.record('/r/stuck', 'file', 0)
      ledger.record('/r/ok', 'file', 0)
      await vi.advanceTimersByTimeAsync(0)
      let rolledBack = false
      void ledger.rollback().then(() => {
        rolledBack = true
      })

      await vi.advanceTimersByTimeAsync(ROLLBACK_LSTAT_TIMEOUT_MS - 1)
      expect(rolledBack).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(rolledBack).toBe(true)
      expect(removeCreatedEntry).toHaveBeenCalledExactlyOnceWith('/r/ok', 'file')
      expect(ledger.remaining).toEqual(['/r/stuck'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops checking after one rollback check times out, so a stalled relay costs one timeout', async () => {
    vi.useFakeTimers()
    try {
      let stalled = false
      const provider = createProvider((path) =>
        stalled
          ? new Promise<FileStat>(() => {})
          : Promise.resolve({ size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length })
      )
      const removeCreatedEntry = vi.fn(async () => {})
      const ledger = new SshImportCreatedLedger(provider, { ...session, removeCreatedEntry })
      const paths = Array.from({ length: 50 }, (_, index) => `/r/f${index}`)
      for (const path of paths) {
        ledger.record(path, 'file', 0)
      }
      await vi.advanceTimersByTimeAsync(0)
      stalled = true
      vi.mocked(provider.lstat)?.mockClear()
      let rolledBack = false
      void ledger.rollback().then(() => {
        rolledBack = true
      })

      await vi.advanceTimersByTimeAsync(ROLLBACK_LSTAT_TIMEOUT_MS)
      expect(rolledBack).toBe(true)
      expect(provider.lstat).toHaveBeenCalledTimes(1)
      expect(removeCreatedEntry).not.toHaveBeenCalled()
      expect(ledger.remaining).toEqual(paths.toReversed())
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips new identity reads while too many abandoned ones are still pending on the relay', async () => {
    vi.useFakeTimers()
    try {
      const provider = createProvider((path) =>
        path.startsWith('/r/stalled')
          ? new Promise<FileStat>(() => {})
          : Promise.resolve({ size: 0, type: 'file', mtime: 0, dev: 1, ino: path.length })
      )
      // Why: two imports on one connection share the relay, so they share the limit.
      const ledgers = [
        new SshImportCreatedLedger(provider, session),
        new SshImportCreatedLedger(provider, session)
      ]
      for (let index = 0; index < IDENTITY_OUTSTANDING_LIMIT; index += 1) {
        ledgers[index % 2]?.record(`/r/stalled${index}`, 'file', 0)
        // Why: past each deadline the slots free, so the next batch is sent while these stay pending.
        if (index % 16 === 15) {
          await vi.advanceTimersByTimeAsync(IDENTITY_READ_DEADLINE_MS + 1)
        }
      }
      expect(provider.lstat).toHaveBeenCalledTimes(IDENTITY_OUTSTANDING_LIMIT)

      const next = new SshImportCreatedLedger(provider, session).record('/r/next', 'file', 0)
      await vi.advanceTimersByTimeAsync(0)
      await expect(next.identity).resolves.toBeNull()
      expect(provider.lstat).toHaveBeenCalledTimes(IDENTITY_OUTSTANDING_LIMIT)
    } finally {
      vi.useRealTimers()
    }
  })
})
