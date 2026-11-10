import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  acquireOrcadInstanceLock,
  type OrcadInstanceLock
} from '../../../../orcad/orcad-instance-lock'
import { DaemonHistoryRetirement } from '../../../providers/adapter/daemon-history-retirement'
import { CheckpointSessionQueue } from '../../../providers/checkpointing/daemon-checkpoint-session-queue'
import { HistoryReader } from '../../restoration/history-reader'
import { HistoryManager } from '../history-manager'
import { flushPendingSessionTreeRemovals } from '../terminal-history-session-tombstone'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'

vi.mock('../../../launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: async () => []
}))

const snapshot: TerminalSnapshot = {
  snapshotAnsi: 'retained predecessor output',
  scrollbackAnsi: '',
  rehydrateSequences: '',
  cwd: '/original',
  cols: 80,
  rows: 24,
  scrollbackLines: 0,
  modes: {
    bracketedPaste: false,
    mouseTracking: false,
    applicationCursor: false,
    alternateScreen: false
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let directory: string
let lock: OrcadInstanceLock
let manager: HistoryManager
const managers: HistoryManager[] = []
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'restore-pty-lifetime-'))
  mkdirSync(join(directory, 'history'))
  mkdirSync(join(directory, 'runtime'))
  lock = acquireOrcadInstanceLock(directory)
  manager = freshManager()
  await manager.identityRoot!.bindProfile(directory, join(directory, 'runtime'), () => [])
  await manager.openSession('9', { cwd: '/original', cols: 80, rows: 24 })
  await manager.checkpoint('9', snapshot)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(managers.splice(0).map((value) => value.releaseIdentity('detach')))
  await flushPendingSessionTreeRemovals()
  lock.release()
  rmSync(directory, { recursive: true, force: true })
})
function freshManager() {
  const value = new HistoryManager(join(directory, 'history'))
  managers.push(value)
  return value
}
async function predecessors(count: number) {
  const queue = new CheckpointSessionQueue(manager.identityRoot!)
  const pending: {
    id: string
    gate: ReturnType<typeof deferred>
    tail: Promise<void>
    retirement: DaemonHistoryRetirement
    release: () => void
  }[] = []
  for (let index = 0; index < count; index++) {
    const id = `workspace@@capture-${index}`
    await manager.openSession(id, { cwd: '/original', cols: 80, rows: 24 })
    const gate = deferred()
    const entered = deferred()
    const tail = queue.run(id, async (receipt) => {
      entered.resolve()
      await gate.promise
      await manager.checkpoint(id, snapshot, undefined, receipt)
    })
    await entered.promise
    const retirement = new DaemonHistoryRetirement(
      `incarnation-${index}`,
      { pid: 1, startedAtMs: 1, launchNonce: 'lifetime-test' },
      manager,
      id,
      manager.captureWriter(id)!,
      queue,
      () => {}
    )
    const release = retirement.hold()
    pending.push({ id, gate, tail, retirement, release })
  }
  return pending
}

it.each([10, 100])(
  'joins only relevant unresolved persistence and forgets settled captures across %i IDs',
  async (count) => {
    const root = manager.identityRoot!
    const source = readFileSync(join(root.path, '9/checkpoint.json'))
    const joins = new Map<string, number>()
    const capture = root.captureWriter.bind(root)
    vi.spyOn(root, 'captureWriter').mockImplementation((id, writer, ready) => {
      // Observe the public obligation supplied to root, including joins of already fulfilled promises.
      const observed = new Proxy(ready, {
        get(target, key) {
          if (key === 'then') {
            return (...args: Parameters<typeof ready.then>) => {
              joins.set(id, (joins.get(id) ?? 0) + 1)
              return target.then(...args)
            }
          }
          if (key === 'catch') {
            return target.catch.bind(target)
          }
          if (key === 'finally') {
            return target.finally.bind(target)
          }
          return key === Symbol.toStringTag ? target[Symbol.toStringTag] : undefined
        }
      })
      return capture(id, writer, observed)
    })
    const pending = await predecessors(count)
    const next = freshManager()
    const acquisitions = pending.map(({ id }) => next.registerWriter(id))
    try {
      await next.openSession('unrelated', { cwd: '/other', cols: 80, rows: 24 })
      expect(joins.size).toBe(count)
      expect([...joins.values()]).toEqual(Array(count).fill(1))
      expect(pending.every(({ id }) => !next.hasWriter(id))).toBe(true)
      for (const item of pending) {
        item.gate.resolve()
      }
      await Promise.all([...pending.map(({ tail }) => tail), ...acquisitions])
      for (const { id } of pending) {
        expect(
          await next.checkpoint(id, { ...snapshot, snapshotAnsi: 'new successor output' })
        ).toBe('committed')
      }
      await next.releaseIdentity('detach')
      for (const item of pending) {
        item.retirement.removeHistory()
        item.release()
        await item.retirement.finish(true)
      }
      joins.clear()
      const later = freshManager()
      for (const { id } of pending) {
        await later.registerWriter(id)
        expect(await new HistoryReader(root.path).detectColdRestore(id)).toMatchObject({
          snapshotAnsi: 'new successor output'
        })
      }
      expect([...joins.values()]).toEqual([])
      for (const { id } of pending) {
        const lease = await root.beginMigration([id], () => true)
        expect(lease?.current()).toBe(true)
        lease!.release()
      }
      expect(readFileSync(join(root.path, '9/checkpoint.json'))).toEqual(source)
    } finally {
      for (const item of pending) {
        item.gate.resolve()
        item.release()
      }
      await Promise.allSettled([...acquisitions, ...pending.map(({ tail }) => tail)])
      await Promise.allSettled(pending.map(({ retirement }) => retirement.finish(true)))
    }
  }
)

it.each([10, 100])(
  'releases expired and retire-canceled admission keys after real predecessor work across %i IDs',
  async (count) => {
    const pending = await predecessors(count)
    const expired = freshManager()
    const canceled = freshManager()
    let expiredWork: Promise<void>[] = []
    let canceledWork: Promise<void>[] = []
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      expiredWork = pending.map(({ id }) => expired.registerWriter(id))
      await vi.advanceTimersByTimeAsync(15_000)
      await Promise.all(expiredWork)
      expect(pending.every(({ id }) => !expired.hasWriter(id))).toBe(true)
      canceledWork = pending.map(({ id }) => canceled.registerWriter(id))
      canceled.retireIdentity(() => Promise.resolve())
      await Promise.all(canceledWork)
      expect(pending.every(({ id }) => !canceled.hasWriter(id))).toBe(true)
      vi.useRealTimers()
      // Caller cancellation cannot discharge the old queue's real write.
      expect(pending.every(({ id }) => manager.hasWriter(id))).toBe(true)
      for (const item of pending) {
        item.gate.resolve()
      }
      await Promise.all(pending.map(({ tail }) => tail))
      for (const item of pending) {
        item.retirement.removeHistory()
        item.release()
        await item.retirement.finish(true)
      }
      const surviving = freshManager()
      for (const { id } of pending) {
        const lease = await surviving.identityRoot!.beginMigration([id], () => true)
        expect(lease?.current()).toBe(true)
        lease!.release()
        expect(
          await new HistoryReader(surviving.identityRoot!.path).detectColdRestore(id)
        ).toMatchObject({ snapshotAnsi: 'retained predecessor output' })
      }
    } finally {
      vi.useRealTimers()
      for (const item of pending) {
        item.gate.resolve()
        item.release()
      }
      await Promise.allSettled([
        ...expiredWork,
        ...canceledWork,
        ...pending.map(({ tail }) => tail)
      ])
      await Promise.allSettled(pending.map(({ retirement }) => retirement.finish(true)))
    }
  }
)

it('keeps a failed exact retirement owned and retries that same tombstone without touching legacy history', async () => {
  const root = manager.identityRoot!
  const source = readFileSync(join(root.path, '9/checkpoint.json'))
  const id = 'workspace@@strict-retry'
  await manager.openSession(id, { cwd: '/original', cols: 80, rows: 24 })
  await manager.checkpoint(id, snapshot)
  const retirement = new DaemonHistoryRetirement(
    'strict-owner',
    { pid: 1, startedAtMs: 1, launchNonce: 'strict-test' },
    manager,
    id,
    manager.captureWriter(id)!,
    new CheckpointSessionQueue(root),
    () => {}
  )
  retirement.removeHistory()
  let completed = false
  void retirement.completion.then(() => {
    completed = true
  })
  const obstruction = join(root.path, '.pending-delete')
  writeFileSync(obstruction, 'owned test obstruction')
  try {
    await expect(retirement.finish(true)).rejects.toThrow()
    expect(completed).toBe(false)
    expect(manager.hasWriter(id)).toBe(true)
    expect(await new HistoryReader(root.path).detectColdRestore(id)).toMatchObject({
      snapshotAnsi: 'retained predecessor output'
    })
  } finally {
    unlinkSync(obstruction)
  }
  await retirement.finish(true)
  await retirement.completion
  expect(completed).toBe(true)
  expect(manager.hasWriter(id)).toBe(false)
  expect(await new HistoryReader(root.path).detectColdRestore(id)).toBeNull()
  expect(readFileSync(join(root.path, '9/checkpoint.json'))).toEqual(source)
})
