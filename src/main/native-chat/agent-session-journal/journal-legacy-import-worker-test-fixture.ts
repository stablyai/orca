import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

export function legacyImportHostExitTestEntry(): string {
  const output = join(dirname(legacyImportWorkerTestEntry()), 'host.cjs')
  buildSync({
    stdin: {
      contents: `
        import { Worker } from 'node:worker_threads'
        import { runLegacyTranscriptImportWorker } from './journal-legacy-import-worker'
        void runLegacyTranscriptImportWorker({}, async () => {}, undefined,
          () => new Worker('setInterval(() => {}, 1000)', { eval: true }))
      `,
      resolveDir: import.meta.dirname
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  return output
}
