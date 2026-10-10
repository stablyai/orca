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
  // Resolves once the async write has serialized and its temp-file write is pending.
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

  it('publishes an async write', async () => {
    const writer = new AtomicSnapshotWriter(() => file)
    await writer.write(() => 'one')
    expect(readFileSync(file, 'utf8')).toBe('one')
    expect(tmpFiles()).toEqual([])
  })

  it('coalesces requests made during an in-flight write to the newest serialize', async () => {
    const writer = new AtomicSnapshotWriter(() => file)
    const first = inFlight('one')
    const pending = writer.write(first.serialize)
    await first.started
    const skipped = vi.fn(() => 'two')
    const newest = vi.fn(() => 'three')
    void writer.write(skipped)
    void writer.write(newest)
    await pending
    await writer.waitForPendingWrite()
    expect(skipped).not.toHaveBeenCalled()
    expect(newest).toHaveBeenCalledTimes(1)
    expect(readFileSync(file, 'utf8')).toBe('three')
  })

  it('skips identical bytes, including content primed from disk', async () => {
    const writer = new AtomicSnapshotWriter(() => file, { skipUnchanged: true })
    await writer.write(() => 'same')
    const { ino } = statSync(file)
    await writer.write(() => 'same')
    writer.writeSync(() => 'same')
    expect(statSync(file).ino).toBe(ino)

    const primed = new AtomicSnapshotWriter(() => file, { skipUnchanged: true })
    primed.primeCommittedContent('same')
    await primed.write(() => 'same')
    expect(statSync(file).ino).toBe(ino)
    await primed.write(() => 'changed')
    expect(readFileSync(file, 'utf8')).toBe('changed')
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
