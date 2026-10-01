import { describe, expect, it } from 'vitest'
import { AdvertisedUrlWatcher } from './advertised-url-watcher'

function heapAfterGc(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function ingestOversizedOutput(watcher: AdvertisedUrlWatcher, bound: boolean): void {
  for (let index = 0; index < 8; index++) {
    const ptyId = `pty-${index}`
    if (bound) {
      watcher.bindPty(ptyId, 'workspace')
    }
    watcher.ingest(
      ptyId,
      `${index}:${'x'.repeat(4 * 1024 * 1024)}\nhttp://localhost:${4100 + index}`
    )
  }
}

describe('advertised URL output retention', () => {
  it.each([true, false])('releases oversized parents with PTYs bound=%s', (bound) => {
    const watcher = new AdvertisedUrlWatcher()
    const before = heapAfterGc()
    ingestOversizedOutput(watcher, bound)
    expect(heapAfterGc() - before).toBeLessThan(2 * 1024 * 1024)

    for (let index = 0; index < 8; index++) {
      const ptyId = `pty-${index}`
      watcher.bindPty(ptyId, 'workspace')
      watcher.ingest(ptyId, '/\n')
      expect(watcher.lookup('workspace', 4100 + index)?.origin).toBe(
        `http://localhost:${4100 + index}`
      )
      watcher.unbindPty(ptyId)
      expect(watcher.lookup('workspace', 4100 + index)).toBeUndefined()
    }
  })
})
