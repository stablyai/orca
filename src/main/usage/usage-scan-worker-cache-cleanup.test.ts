import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { durableWriteTempPath } from '../durable-file-write'
import { createUsageScanWorkerTransport } from './usage-scan-worker-cache-cleanup'
import type { UsageScanWorkerRequest } from './usage-scan-worker-protocol'
import { usageSourceCachePath } from './usage-source-cache-file'

let directory: string
let cacheModule: string

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-usage-worker-cleanup-'))
  cacheModule = join(directory, 'source-cache.cjs')
  await build({
    entryPoints: [resolve(__dirname, 'usage-source-cache-file.ts')],
    outfile: cacheModule,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// Pause an actual durable write after opening its temp; terminating the worker skips its finally.
const BLOCKED_WRITE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (args[1] === 'w') {
    await handle.writeFile('partial-cache');
    parentPort.postMessage(args[0]);
    await new Promise(() => {});
  }
  return handle;
};
const cache = require(workerData.cacheModule);
parentPort.on('message', (request) => {
  const ref = request.operation === 'scan' ? request.sourceCache : {
    path: cache.usageSourceCachePath(request.cacheFile),
    schemaVersion: 1, worktreeFingerprint: '[]', reuse: false
  };
  cache.writeUsageSourceCache(ref, [{ id: 'source' }]);
});
`

describe('usage worker cache cleanup', () => {
  it.each(['scan', 'splitCacheFile'] as const)(
    'reclaims only the exited %s worker temp while replacement writes survive',
    async (operation) => {
      const cacheFile = join(directory, `${operation}.json`)
      const sourcePath = usageSourceCachePath(cacheFile)
      const worker = new Worker(BLOCKED_WRITE_WORKER, {
        eval: true,
        workerData: { cacheModule }
      })
      const transport = createUsageScanWorkerTransport(() => worker)
      try {
        const started = once(worker, 'message')
        const request: UsageScanWorkerRequest =
          operation === 'scan'
            ? {
                id: 1,
                operation,
                providerId: 'codex',
                worktrees: [],
                sourceCache: {
                  path: sourcePath,
                  schemaVersion: 1,
                  worktreeFingerprint: '[]',
                  reuse: false
                }
              }
            : { id: 1, operation, cacheFile, sourceKey: 'processedFiles' }
        transport.postMessage(request)
        const [tempPath] = await started
        if (typeof tempPath !== 'string') {
          throw new Error('Worker did not report its temporary path')
        }
        const replacement = durableWriteTempPath(sourcePath, String(worker.threadId + 1))
        writeFileSync(replacement, 'replacement-cache')
        expect(existsSync(tempPath)).toBe(true)

        await transport.terminate()

        expect(existsSync(tempPath)).toBe(false)
        expect(existsSync(replacement)).toBe(true)
      } finally {
        await worker.terminate()
      }
    },
    15_000
  )
})
