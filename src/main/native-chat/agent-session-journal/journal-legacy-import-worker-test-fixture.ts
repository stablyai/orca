import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll } from 'vitest'
import type { LegacyTranscriptImportRequest } from './journal-legacy-import-worker-protocol'

let directory: string | undefined

/** Compile the real entry as a Node worker fixture, without an application build. */
export function legacyImportWorkerTestEntry(): string {
  if (!directory) {
    directory = mkdtempSync(join(tmpdir(), 'orca-import-worker-test-'))
    buildSync({
      entryPoints: [
        fileURLToPath(new URL('./journal-legacy-import-worker-entry.ts', import.meta.url))
      ],
      outfile: join(directory, 'worker.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  }
  return join(directory, 'worker.cjs')
}

export function createLegacyImportTestWorker(request: LegacyTranscriptImportRequest): Worker {
  return new Worker(legacyImportWorkerTestEntry(), { workerData: request, execArgv: [] })
}

afterAll(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
})
