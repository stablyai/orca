import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { UsageScanWorkerClient } from './usage-scan-worker-client'
import type { UsageSourceCacheRef } from '../cache/usage-source-cache-file'

let corpusRoot = ''
let workerEntryPath = ''
const workers: Worker[] = []

beforeAll(async () => {
  corpusRoot = mkdtempSync(join(tmpdir(), 'orca-selected-profile-worker-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', corpusRoot)
  vi.stubEnv('HOME', corpusRoot)
  vi.stubEnv('USERPROFILE', corpusRoot)
  workerEntryPath = join(corpusRoot, 'usage-scan-worker-entry.cjs')
  // Workers need JavaScript; bundle the production entry, not a replacement scanner.
  await build({
    entryPoints: [resolve(__dirname, 'usage-scan-worker-entry.ts')],
    outfile: workerEntryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron']
  })
}, 120_000)

afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.terminate()))
  vi.unstubAllEnvs()
  if (corpusRoot) {
    rmSync(corpusRoot, { recursive: true, force: true })
  }
})

it('isolates selected profiles when the real worker reuses its source cache', async () => {
  const selected = join(corpusRoot, 'selected-claude', 'projects')
  const next = join(corpusRoot, 'next-claude', 'projects')
  const unrelated = join(corpusRoot, '.claude', 'projects')
  for (const [directory, sessionId] of [
    [selected, 'selected'],
    [next, 'next'],
    [unrelated, 'unrelated']
  ] as const) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        sessionId,
        timestamp: '2026-10-10T12:00:00Z',
        message: {
          id: sessionId,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 2 }
        }
      })}\n`
    )
  }
  const client = new UsageScanWorkerClient({
    workerFactory: () => {
      const worker = new Worker(workerEntryPath)
      workers.push(worker)
      return worker
    },
    log: () => {}
  })
  const sourceCache: UsageSourceCacheRef = {
    path: join(corpusRoot, 'selected-claude-sources.json'),
    schemaVersion: 7,
    worktreeFingerprint: '[]',
    reuse: true
  }
  for (const [directory, expected] of [
    [selected, 'selected'],
    [next, 'next']
  ] as const) {
    const result = await client.scan({
      operation: 'scan',
      providerId: 'claude',
      profileDirs: [directory],
      worktrees: [],
      sourceCache
    })
    if (result.operation !== 'scan' || result.providerId !== 'claude') {
      throw new Error('Expected Claude worker response')
    }
    expect(result.sessions.map((session) => session.sessionId)).toEqual([expected])
  }
})
