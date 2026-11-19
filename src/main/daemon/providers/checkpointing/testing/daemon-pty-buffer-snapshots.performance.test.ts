import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../../adapter/daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../../adapter/testing/daemon-pty-adapter-test-harness'
import { SettledDurableHistory } from '../settled-durable-history'
import * as durableHistory from '../daemon-durable-history-snapshot'

class HistoryReads extends DaemonPtyAdapter {
  protected override scheduleCheckpointTimer(): void {}

  denyReads(denied: boolean): void {
    if (denied) {
      for (const id of ['a', 'b', 'c', 'd']) {
        this.nonFinalCheckpointAdmissionSessionIds.add(id)
      }
    } else {
      this.nonFinalCheckpointAdmissionSessionIds.clear()
    }
  }

  setCacheBudget(bytes: number): void {
    this.settledDurableHistory.clear()
    this.settledDurableHistory = new SettledDurableHistory(bytes)
  }

  returnDeadlineFallbackAfterCommit(): void {
    vi.spyOn(this.checkpointQueue, 'runWithDeadline').mockImplementation(
      async <T>(_id: string, work: () => Promise<T>, _deadline: number, fallback: T) => {
        await work()
        return fallback
      }
    )
  }

  historySource() {
    return this.historyReader!
  }

  async settle(id: string): Promise<void> {
    await this.checkpointQueue.run(id, async () => {})
  }
}

let rig: DaemonAdapterHarness
let adapter: HistoryReads
let subprocess: ReturnType<typeof createMockSubprocess>
const id = 'history'
const read = (rows = 2000) => adapter.getBufferSnapshot(id, { scrollbackRows: rows })

beforeEach(async () => {
  rig = await startDaemonAdapterHarness(() => {
    subprocess = createMockSubprocess()
    return subprocess
  })
  adapter = new HistoryReads({
    socketPath: rig.socketPath,
    tokenPath: rig.tokenPath,
    historyPath: join(rig.dir, 'history')
  })
  await adapter.spawn({ sessionId: id, cols: 80, rows: 24, cwd: '/tmp' })
  await emit(Array.from({ length: 6000 }, (_, index) => `line ${index + 1}\r\n`).join(''))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  adapter?.dispose()
  rig?.adapter.dispose()
  await rig?.server.shutdown()
  if (rig) {
    rmSync(rig.dir, { recursive: true, force: true })
  }
})

async function emit(data: string): Promise<void> {
  const delivered = new Promise<void>((resolve) => {
    let received = 0
    const stop = adapter.onData((event) => {
      received += event.sequenceChars ?? event.data.length
      if (received >= data.length) {
        stop()
        resolve()
      }
    })
  })
  subprocess._simulateData(data)
  await delivered
}

it.each([12, 120])(
  'compacts once for %i sequential mixed-size callers, then once per mutation',
  async (callers) => {
    const writes = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
    const bounds = vi.spyOn(durableHistory, 'boundSnapshot')
    const historyReads = vi.spyOn(adapter.historySource(), 'detectColdRestore')
    for (let caller = 0; caller < callers; caller++) {
      const small = await read(2000)
      expect(small?.historyLimited).toBeUndefined()
      expect(small?.data).toContain('line 6000')
      expect(small?.data).not.toContain('line 1000\r\n')
      const large = await read(5000)
      expect(large?.historyLimited).toBeUndefined()
      expect(large?.data).toContain('line 2000')
    }
    expect(writes).toHaveBeenCalledTimes(1)
    expect(historyReads).toHaveBeenCalledTimes(1)
    expect(bounds).toHaveBeenCalledTimes(callers)
    await emit('new output\r\n')
    expect((await read())?.data).toContain('new output')
    await read(5000)
    expect(writes).toHaveBeenCalledTimes(2)
    await adapter.clearBuffer(id)
    expect((await read())?.data).not.toContain('line 2000')
    await read(5000)
    expect(writes).toHaveBeenCalledTimes(3)
    adapter.resize(id, 60, 24)
    expect(await read()).toMatchObject({ cols: 60 })
    await read(5000)
    expect(writes).toHaveBeenCalledTimes(4)
    await adapter.resetInputModes(id)
    expect((await read())?.historyLimited).toBeUndefined()
    await read(5000)
    expect(writes).toHaveBeenCalledTimes(5)
  },
  30_000
)

it('never caches denied or failed overlays as complete and repairs them after a commit', async () => {
  const writes = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
  adapter.denyReads(true)
  expect(await read()).toMatchObject({ historyLimited: true })
  expect(await read()).toMatchObject({ historyLimited: true })
  expect(writes).not.toHaveBeenCalled()
  adapter.denyReads(false)
  expect((await read())?.historyLimited).toBeUndefined()
  expect(writes).toHaveBeenCalledTimes(1)
  await emit('after denied read\r\n')
  writes.mockRejectedValueOnce(new Error('disk failure'))
  expect(await read()).toMatchObject({ historyLimited: true })
  expect(writes).toHaveBeenCalledTimes(2)
  expect((await read())?.historyLimited).toBe(true)
  expect((await read())?.historyLimited).toBe(true)
  expect(writes).toHaveBeenCalledTimes(4)
})

it('publishes an eventual complete commit after a caller deadline, without another compaction', async () => {
  const manager = adapter.getHistoryManager()!
  const original = manager.checkpoint.bind(manager)
  let release = (): void => {}
  let entered = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const writes = vi.spyOn(manager, 'checkpoint').mockImplementation(async (...args) => {
    entered()
    await gate
    return original(...args)
  })
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = read()
    await started
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ historyLimited: true })
    expect(await read()).toMatchObject({ historyLimited: true })
    expect((await adapter.getBufferSnapshot(id, { scrollbackRows: 1000 }))?.data).toContain(
      'line 6000'
    )
  } finally {
    vi.useRealTimers()
    release()
  }
  await adapter.settle(id)
  expect((await read())?.historyLimited).toBeUndefined()
  expect((await read(5000))?.data).toContain('line 2000')
  expect(writes).toHaveBeenCalledTimes(1)
})

it.each(['clear', 'resize back', 'reset'])(
  'rejects an external %s while its checkpoint is persisting',
  async (mutation) => {
    const manager = adapter.getHistoryManager()!
    const original = manager.checkpoint.bind(manager)
    let release = (): void => {}
    let entered = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const writes = vi.spyOn(manager, 'checkpoint').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return original(...args)
    })
    const pending = read()
    try {
      await started
      await rig.adapter.establishLifecycleLease()
      if (mutation === 'clear') {
        await rig.adapter.clearBuffer(id)
      } else if (mutation === 'resize back') {
        rig.adapter.resize(id, 60, 24)
        rig.adapter.resize(id, 80, 24)
        await rig.adapter.getBufferSnapshot(id, { scrollbackRows: 0 })
      } else {
        await rig.adapter.resetInputModes(id)
      }
    } finally {
      release()
    }
    const stale = await pending
    expect(stale).toMatchObject({ historyLimited: true })
    if (mutation === 'clear') {
      expect(stale?.data).not.toContain('line 2000')
      expect((await read())?.data).not.toContain('line 2000')
    } else {
      expect((await read())?.historyLimited).toBeUndefined()
    }
    await read(5000)
    expect(writes).toHaveBeenCalledTimes(2)
  }
)

it('evicts history by aggregate retained bytes and leaves lifecycle overlays uncached', async () => {
  adapter.setCacheBudget(1)
  const writes = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
  await read()
  await read(5000)
  expect(writes).toHaveBeenCalledTimes(2)
  adapter.setCacheBudget(16 * 1024 * 1024)
  await read()
  await read(5000)
  expect(writes).toHaveBeenCalledTimes(3)
  await adapter.getBufferSnapshot(id)
  await adapter.getBufferSnapshot(id, { scrollbackRows: 5000, recovery: true })
  expect(writes).toHaveBeenCalledTimes(5)
})

it('does not treat a committed live fallback as proven durable coverage', async () => {
  const writes = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
  await read()
  await emit('continuity lost\r\n')
  const source = vi.spyOn(adapter.historySource(), 'detectColdRestore').mockResolvedValueOnce(null)
  expect(await read()).toMatchObject({ historyLimited: true })
  expect(writes).toHaveBeenCalledTimes(2)
  expect(source).toHaveBeenCalledTimes(1)
  expect(await read()).toMatchObject({ historyLimited: true })
  expect(writes).toHaveBeenCalledTimes(3)
})

it('evicts across sessions when their combined history exceeds the byte budget', async () => {
  adapter.setCacheBudget(200_000)
  const writes = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
  await read()
  await read(5000)
  expect(writes).toHaveBeenCalledTimes(1)
  await adapter.spawn({ sessionId: 'other', cols: 80, rows: 24, cwd: '/tmp' })
  await emit(Array.from({ length: 6000 }, (_, index) => `other line ${index + 1}\r\n`).join(''))
  expect(
    (await adapter.getBufferSnapshot('other', { scrollbackRows: 5000 }))?.historyLimited
  ).toBeUndefined()
  expect(writes).toHaveBeenCalledTimes(2)
  expect((await read(5000))?.data).toContain('line 2000')
  await read()
  expect(writes).toHaveBeenCalledTimes(3)
})

it('keeps the selected deadline fallback limited even if the commit has already completed', async () => {
  const writes = vi.spyOn(adapter.getHistoryManager()!, 'checkpoint')
  adapter.returnDeadlineFallbackAfterCommit()
  expect(await read()).toMatchObject({ historyLimited: true })
  expect((await read(5000))?.historyLimited).toBeUndefined()
  expect(writes).toHaveBeenCalledTimes(1)
})
