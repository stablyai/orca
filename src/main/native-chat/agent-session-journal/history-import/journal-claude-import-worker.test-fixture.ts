// @orca-isolated-worker -- Suite hooks own the temporary import worker bundle.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { setHeavyWorkerHost } from '../../../utility-worker-host/heavy-worker-spawn'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type { ClaudeImportWork } from './journal-claude-import-worker-protocol'
import type { ClaudeImportScratchOptions } from './journal-claude-import-scratch'

const scratchOptions = new Map<string, ClaudeImportScratchOptions>()
const defaultHost = {
  spawn: spawnWorkerThread,
  retry: () => undefined,
  pauseMessage: () => null
}

export function useImportScratch(sessionId: string, scratch: ClaudeImportScratchOptions): void {
  scratchOptions.set(sessionId, scratch)
}

let bundleRoot = ''

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-claude-import-worker-'))
  await build({
    entryPoints: [
      resolve(
        'src/main/native-chat/agent-session-journal/history-import/journal-claude-import-worker-entry.ts'
      )
    ],
    outdir: bundleRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  const entry = join(bundleRoot, 'journal-claude-import-worker-entry.js')
  setHeavyWorkerHost({
    ...defaultHost,
    spawn(filename, options) {
      if (options.name !== 'orca-claude-history-import') {
        return spawnWorkerThread(filename, options)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker role identifies the import protocol.
      const work = options.workerData as ClaudeImportWork
      return spawnWorkerThread(entry, {
        ...options,
        workerData: {
          ...work,
          scratch: { parent: join(bundleRoot, 'scratch'), ...scratchOptions.get(work.sessionId) }
        }
      })
    }
  })
})
afterAll(() => {
  setHeavyWorkerHost(defaultHost)
  rmSync(bundleRoot, { recursive: true, force: true })
})
