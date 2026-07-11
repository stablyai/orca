import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: spawnMock }))

import { createWslSnapshotEngine } from './filesystem-watcher-wsl-engine'
import { MAX_SNAPSHOT_RECORD_CHARS } from './filesystem-watcher-wsl-snapshot'

class FakeSnapshotChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
}

afterEach(() => spawnMock.mockReset())

function createEngine(child: FakeSnapshotChild, onOverflow = vi.fn()) {
  spawnMock.mockReturnValueOnce(child)
  return {
    engine: createWslSnapshotEngine({
      distro: 'Ubuntu',
      linuxPath: '/repo',
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\repo',
      ignoreDirs: [],
      onEvents: vi.fn(),
      onOverflow
    }),
    onOverflow
  }
}

describe('WSL snapshot stream parser', () => {
  it('incrementally accepts frames larger than 10 MiB with chunked Unicode', async () => {
    const child = new FakeSnapshotChild()
    const { engine, onOverflow } = createEngine(child)
    const unicode = 'æµ‹è¯•ðŸŒŠ'
    const records = `${Array.from(
      { length: 13_000 },
      (_, index) => `f\t1.0\t/repo/${unicode}-${index}-${'x'.repeat(780)}\0`
    ).join('')}\0`
    const bytes = Buffer.from(records)
    for (let offset = 0; offset < bytes.length; offset += 997) {
      child.stdout.write(bytes.subarray(offset, offset + 997))
    }
    await expect(engine.ready).resolves.toBeUndefined()
    expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024)
    expect(onOverflow).not.toHaveBeenCalled()
    engine.stop()
  })

  it('bounds a single unterminated record', () => {
    const child = new FakeSnapshotChild()
    const { engine, onOverflow } = createEngine(child)
    child.stdout.write('x'.repeat(MAX_SNAPSHOT_RECORD_CHARS + 1))
    expect(onOverflow).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    engine.stop()
  })
})
