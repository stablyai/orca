import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicSnapshotWriter } from './atomic-snapshot-writer'

describe('AtomicSnapshotWriter', () => {
  let dir: string
  let file: string

  const tmpFiles = (): string[] =>
    readdirSync(join(dir, 'nested')).filter((name) => name.endsWith('.tmp'))
  // Signal after serialization, while the asynchronous temporary-file write is pending.
  const inFlight = (content: string): { serialize: () => string; started: Promise<void> } => {
    let markStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    return {
      serialize: () => {
        markStarted()
        return content
      },
      started
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-atomic-writer-'))
    file = join(dir, 'nested', 'snapshot.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the newest writeSync content when an older async write finishes later', async () => {
    const writer = new AtomicSnapshotWriter(() => file)
    const stale = inFlight('stale')
    const pending = writer.write(stale.serialize)
    await stale.started
    writer.writeSync(() => 'newest')
    await pending
    expect(readFileSync(file, 'utf8')).toBe('newest')
    expect(tmpFiles()).toEqual([])
  })

  it('close() stops queued and in-flight async writes from publishing', async () => {
    const writer = new AtomicSnapshotWriter(() => file)
    const queued = vi.fn(() => 'queued')
    const queuedWrite = writer.write(queued)
    writer.close()
    await queuedWrite
    expect(queued).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)

    const other = new AtomicSnapshotWriter(() => file)
    const running = inFlight('in flight')
    const pending = other.write(running.serialize)
    await running.started
    other.close()
    await pending
    expect(existsSync(file)).toBe(false)
    expect(tmpFiles()).toEqual([])
    await other.write(() => 'after close')
    expect(existsSync(file)).toBe(false)
    other.writeSync(() => 'sync after close')
    expect(readFileSync(file, 'utf8')).toBe('sync after close')
  })

  it.skipIf(process.platform === 'win32')('applies fileMode and directoryMode', async () => {
    const writer = new AtomicSnapshotWriter(() => file, { fileMode: 0o600, directoryMode: 0o700 })
    await writer.write(() => 'secret')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
    expect(tmpFiles()).toEqual([])
  })
})
