import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { STATUS_PERSIST_MIN_INTERVAL_MS } from './server/server-constants'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

class ProbeServer extends AgentHookServer {
  persistTimerArmed(): boolean {
    return this.statusPersistTimer !== null
  }

  persistDueAt(): number {
    return this.statusPersistDueAt
  }

  requestPersist(): void {
    this.scheduleStatusPersist()
  }
}

describe('last-status persist throttle', () => {
  let userDataPath: string
  let server: ProbeServer

  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const readPrompt = (): unknown =>
    JSON.parse(readFileSync(lastStatusPath(), 'utf8')).entries[PANE]?.payload?.prompt
  const prompt = (text: string, launchToken?: string): Promise<Response> =>
    postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: text },
        launchToken ? { launchToken } : {}
      )
    )

  beforeEach(async () => {
    _internals.resetCachesForTests()
    // Why shouldAdvanceTime: the hooks are real loopback POSTs, which need the clock to move.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'Date']
    })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-persist-throttle-'))
    server = new ProbeServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('starts an isolated write after idle on the next turn', async () => {
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS * 2)
    await prompt('after idle')
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(2)
    await write.mock.results[1]?.value
    expect(readPrompt()).toBe('after idle')
  })

  it('caps a steady stream at one write per window without pushing the timer back', async () => {
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    let unchangedWhileArmed = 0
    for (let i = 0; i < 60; i++) {
      const armedBefore = server.persistTimerArmed()
      const dueBefore = server.persistDueAt()
      await prompt(`stream ${i}`)
      if (armedBefore && server.persistTimerArmed()) {
        expect(server.persistDueAt()).toBe(dueBefore)
        unchangedWhileArmed++
      }
      if (server.persistTimerArmed()) {
        expect(server.persistDueAt() - Date.now()).toBeLessThanOrEqual(
          STATUS_PERSIST_MIN_INTERVAL_MS
        )
      }
      await vi.advanceTimersByTimeAsync(500)
    }
    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS)
    expect(write).toHaveBeenCalledTimes(7)
    expect(unchangedWhileArmed).toBeGreaterThan(40)
    await Promise.all(write.mock.results.map((result) => result.value))
    expect(readPrompt()).toBe('stream 59')
    expect(server.persistTimerArmed()).toBe(false)
  })

  it('writes an authority change immediately instead of waiting for the window', async () => {
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    await prompt('second')
    expect(server.persistTimerArmed()).toBe(true)

    await prompt('third', 'launch-token-new')
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(2)
    await write.mock.results[1]?.value
    expect(JSON.parse(readFileSync(lastStatusPath(), 'utf8')).entries[PANE]).toMatchObject({
      launchTokenHash: expect.any(String)
    })
  })

  it('does not replace the file when the serialized state is identical', async () => {
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    await prompt('only')
    await vi.advanceTimersByTimeAsync(1)
    await write.mock.results[0]?.value
    const { ino, mtimeMs } = statSync(lastStatusPath())

    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS)
    server.requestPersist()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(2)
    await write.mock.results[1]?.value
    server.flushStatusPersistSync()
    expect(statSync(lastStatusPath())).toMatchObject({ ino, mtimeMs })
  })

  it('flushStatusPersistSync cancels the armed timer and writes synchronously', async () => {
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    const writeSync = vi.spyOn(AtomicSnapshotWriter.prototype, 'writeSync')
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    await write.mock.results[0]?.value
    await prompt('second')
    expect(server.persistTimerArmed()).toBe(true)

    server.flushStatusPersistSync()
    expect(server.persistTimerArmed()).toBe(false)
    expect(writeSync).toHaveBeenCalledTimes(1)
    expect(readPrompt()).toBe('second')

    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS * 2)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('stop then start leaves no armed timer and never overwrites the file with stale state', async () => {
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    await write.mock.results[0]?.value
    await prompt('final before stop')
    expect(server.persistTimerArmed()).toBe(true)

    server.stop()
    const afterStop = readFileSync(lastStatusPath(), 'utf8')
    expect(readPrompt()).toBe('final before stop')
    await server.start({ env: 'production', userDataPath })
    expect(server.persistTimerArmed()).toBe(false)

    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS * 2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(readFileSync(lastStatusPath(), 'utf8')).toBe(afterStop)
  })

  it('warns once for a failing async write and retries in the next window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = vi
      .spyOn(AtomicSnapshotWriter.prototype, 'write')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))
    const persistWarnings = (): number =>
      warn.mock.calls.filter(([message]) =>
        String(message).includes('failed to write last-status file')
      ).length

    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(persistWarnings()).toBe(1)
    expect(server.persistTimerArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS)
    expect(write).toHaveBeenCalledTimes(2)
    expect(persistWarnings()).toBe(1)

    await vi.advanceTimersByTimeAsync(STATUS_PERSIST_MIN_INTERVAL_MS)
    expect(write).toHaveBeenCalledTimes(3)
    await write.mock.results[2]?.value
    expect(readPrompt()).toBe('first')
    expect(persistWarnings()).toBe(1)
  })
})
