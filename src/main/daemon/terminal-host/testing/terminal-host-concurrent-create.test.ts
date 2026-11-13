import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { TerminalHistoryJournals } from '../../history/journal/terminal-history-journals'
import { getHistorySessionDirName } from '../../history/storage/history-paths'
import {
  newTerminalHistoryMeta,
  writeTerminalHistoryMeta
} from '../../history/storage/terminal-history-metadata'

import { TerminalHost } from '../terminal-host'

vi.mock('../../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

type MockSubprocess = SubprocessHandle & {
  emitData: (data: string) => void
  emitExit: (code: number) => void
}

function mockSubprocess(
  options: { confirmShellForeground?: () => Promise<boolean> } = {}
): MockSubprocess {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 4242,
    getForegroundProcess: vi.fn(() => null),
    ...(options.confirmShellForeground
      ? { confirmShellForeground: options.confirmShellForeground }
      : {}),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 1)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    emitData(data) {
      onDataCb?.(data)
    },
    emitExit(code) {
      onExitCb?.(code)
    }
  } as MockSubprocess
}

const streamClient = { onData: vi.fn(), onExit: vi.fn() }

function createOptions(sessionId: string) {
  return { sessionId, cols: 80, rows: 24, streamClient }
}

describe('concurrent createOrAttach across the async spawn', () => {
  it('lets a canceled caller stop waiting on a create stuck on a dead share', async () => {
    let releaseSpawn: () => void = () => {}
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        await spawnGate
        return mockSubprocess()
      }
    })

    const stuck = host.createOrAttach(createOptions('dead-share-session'))
    const abort = new AbortController()
    const queued = host.createOrAttach({
      ...createOptions('dead-share-session'),
      cancelSignal: abort.signal
    })
    abort.abort()

    // Cancellation must release the queued caller even while the earlier spawn remains blocked.
    await expect(queued).rejects.toThrow('Attach canceled')

    releaseSpawn()
    await stuck
    await host.dispose()
  })
})

const historyRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of historyRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('a start that never produced a process', () => {
  // Its history hold is rolled back inside the failed creation, so the failure's answer, and any
  // same-ID start waiting behind it, find the clean-ended predecessor already restored.
  it.each([
    ['its process never forked', false],
    ['it was canceled after its hold was written', true]
  ])('answers only once the predecessor is restored when %s', async (_, cancelAfterHold) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hold-rollback-'))
    historyRoots.push(root)
    const sessionId = 'hold-rollback'
    const dir = join(root, getHistorySessionDirName(sessionId))
    mkdirSync(dir, { recursive: true })
    const ended = {
      ...newTerminalHistoryMeta({ cwd: '/tmp', cols: 80, rows: 24 }, null),
      endedAt: '2026-11-01T11:00:00.000Z',
      exitCode: 0
    }
    writeTerminalHistoryMeta(dir, ended)
    const savedMeta = () => JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    let canceled = false
    if (cancelAfterHold) {
      const rename = fsPromises.rename
      vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        await rename(from, to)
        canceled = true
      })
    }
    let fail = !cancelAfterHold
    const host = new TerminalHost({
      historyJournals: new TerminalHistoryJournals(root),
      spawnSubprocess: async (opts) => {
        if (fail) {
          opts.onCreationDisposition?.({ kind: 'no-fork' })
          throw new Error('spawn failed')
        }
        return mockSubprocess()
      }
    })

    const answered = await host
      .createOrAttach({ ...createOptions(sessionId), isCanceled: () => canceled })
      .then(
        () => 'started',
        () => savedMeta()
      )
    expect(answered).toEqual(ended)

    vi.restoreAllMocks()
    canceled = false
    fail = false
    await host.createOrAttach(createOptions(sessionId))
    expect(savedMeta()).toMatchObject({ endedAt: null, exitCode: null })
    await host.dispose()
  })

  // A same-ID start attempted while the rollback's rename is in flight waits behind it: canceling
  // it then starts nothing, and a start that keeps waiting runs over the restored predecessor.
  it('holds a same-ID start until a never-forked start has restored its predecessor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hold-rollback-'))
    historyRoots.push(root)
    const sessionId = 'hold-rollback-successor'
    const dir = join(root, getHistorySessionDirName(sessionId))
    mkdirSync(dir, { recursive: true })
    const ended = {
      ...newTerminalHistoryMeta({ cwd: '/tmp', cols: 80, rows: 24 }, null),
      endedAt: '2026-11-01T11:00:00.000Z',
      exitCode: 0
    }
    writeTerminalHistoryMeta(dir, ended)
    const savedMeta = () => JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    let rollingBack = false
    const rollback = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const rename = fsPromises.rename
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (rollingBack) {
        rollingBack = false
        rollback.resolve()
        await release.promise
      }
      return rename(from, to)
    })
    let fail = true
    const startedOver: unknown[] = []
    const host = new TerminalHost({
      historyJournals: new TerminalHistoryJournals(root),
      spawnSubprocess: async (opts) => {
        if (fail) {
          rollingBack = true
          opts.onCreationDisposition?.({ kind: 'no-fork' })
          throw new Error('spawn failed')
        }
        startedOver.push(savedMeta())
        return mockSubprocess()
      }
    })

    const failed = host.createOrAttach(createOptions(sessionId)).then(
      () => 'started',
      () => savedMeta()
    )
    // Sync point only: the rollback's restore rename is issued and held.
    await rollback.promise
    fail = false
    const abort = new AbortController()
    const canceled = host.createOrAttach({
      ...createOptions(sessionId),
      cancelSignal: abort.signal
    })
    const waiting = host.createOrAttach(createOptions(sessionId))
    abort.abort()

    await expect(canceled).rejects.toThrow('Attach canceled')
    expect(startedOver).toEqual([])
    release.resolve()
    expect(await failed).toEqual(ended)
    await waiting
    expect(startedOver).toEqual([expect.objectContaining({ endedAt: null, exitCode: null })])
    expect(savedMeta()).toMatchObject({ endedAt: null, exitCode: null })
    await host.dispose()
  })
})
