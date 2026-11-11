import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryReader } from '../history-reader'
import { PrioritySemaphore } from '../../../../../shared/priority-semaphore'
import { HeadlessEmulator } from '../../../emulation/headless-emulator'
import { getHistorySessionDirName } from '../../storage/history-paths'
import { encodeLogBatch, encodeLogHeader } from '../../storage/terminal-history-log'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('history replay admission', () => {
  const directories: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function historyReader(output = 'saved output\r\n') {
    const path = mkdtempSync(join(tmpdir(), 'sta14647-history-admission-'))
    directories.push(path)
    const session = join(path, getHistorySessionDirName('saved'))
    mkdirSync(session)
    writeFileSync(
      join(session, 'meta.json'),
      JSON.stringify({
        cwd: '/project',
        cols: 80,
        rows: 24,
        startedAt: '2026-04-15T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    writeFileSync(
      join(session, 'output.log'),
      Buffer.concat([encodeLogHeader(0), encodeLogBatch(1, [{ kind: 'output', data: output }])])
    )
    return new HistoryReader(path)
  }

  it('lets a foreground restore pass queued retained reads and removes an abandoned read', async () => {
    const reader = historyReader()
    const occupied = deferred()
    const unblock = deferred()
    const retainedQueued = deferred()
    const foregroundQueued = deferred()
    const abandonedQueued = deferred()
    const abandoned = new AbortController()
    const acquire = PrioritySemaphore.prototype.acquire
    let first = true
    vi.spyOn(PrioritySemaphore.prototype, 'acquire').mockImplementation(function (
      this: PrioritySemaphore,
      priority,
      signal
    ) {
      const pending = acquire.call(this, priority, signal)
      if (first) {
        first = false
        return pending.then(async (release) => {
          occupied.resolve()
          await unblock.promise
          return release
        })
      }
      if (signal === abandoned.signal) {
        abandonedQueued.resolve()
      } else if (priority === 0) {
        foregroundQueued.resolve()
      } else {
        retainedQueued.resolve()
      }
      return pending
    })
    const order: string[] = []
    const initial = reader.detectColdRestore('saved').then(() => {
      order.push('initial')
    })
    await occupied.promise
    try {
      const retained = reader.detectColdRestore('saved', { priority: 1 }).then(() => {
        order.push('retained')
      })
      await retainedQueued.promise
      const retired = reader.detectColdRestore('saved', { priority: 1, signal: abandoned.signal })
      const rejected = expect(retired).rejects.toThrow('renderer retired')
      await abandonedQueued.promise
      const foreground = reader.detectColdRestore('saved').then((result) => {
        expect(result?.snapshotAnsi).toContain('saved output')
        order.push('foreground')
      })
      await foregroundQueued.promise
      abandoned.abort(new Error('renderer retired'))
      await rejected
      unblock.resolve()
      await Promise.all([initial, retained, foreground])
      expect(order).toEqual(['initial', 'foreground', 'retained'])
    } finally {
      unblock.resolve()
      await initial
    }
  })

  it('abandons active replay at its next yield and releases admission for a later restore', async () => {
    const reader = historyReader(`original screen\r\n${'retained line\r\n'.repeat(8000)}`)
    const controller = new AbortController()
    const write = HeadlessEmulator.prototype.writeSync
    const observer = vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockImplementation(function (
      this: HeadlessEmulator,
      data
    ) {
      const result = write.call(this, data)
      controller.abort(new Error('document replaced'))
      return result
    })
    await expect(
      reader.detectColdRestore('saved', { priority: 1, signal: controller.signal })
    ).rejects.toThrow('document replaced')
    observer.mockRestore()
    expect((await reader.detectColdRestore('saved'))?.snapshotAnsi).toContain('retained line')
  })
})
