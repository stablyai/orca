import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  importClaudeTranscriptInWorker,
  type ClaudeImportWorker
} from './journal-claude-import-worker'
import { useClaudeImportWorker } from './journal-claude-import-worker.test-fixture'

const controller = new AbortController()
const prepared: ClaudeImportWorker[] = []
let restoreHost: (() => void) | undefined
let directory: string | undefined

afterEach(async () => {
  controller.abort()
  try {
    await Promise.all(prepared.map((worker) => worker.close()))
  } finally {
    restoreHost?.()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

it('admits another preparation while earlier imports still own verified sources', async () => {
  restoreHost = useClaudeImportWorker()
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-admission-'))
  const filePath = join(directory, 'session.jsonl')
  await writeFile(filePath, '{"type":"user","uuid":"u1","message":{"content":"question"}}')
  const prepare = async () => {
    const worker = await importClaudeTranscriptInWorker(
      {
        filePath,
        retainedBytes: 16 * 1024,
        limits: { inlineHeadBytes: 16 * 1024 },
        agent: 'claude',
        sessionId: 'session',
        signal: controller.signal
      },
      async () => {}
    )
    prepared.push(worker)
    return worker
  }

  const earlier = await Promise.all([prepare(), prepare()])
  const later = await prepare()
  expect(later.count).toBe(1)
  for (const worker of earlier) {
    await expect(worker.verify()).resolves.toMatchObject({ path: filePath })
  }
})
