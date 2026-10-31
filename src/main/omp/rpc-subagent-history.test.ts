import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readOmpSubagentHistoryFiles } from './rpc-subagent-history'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('only discovers child transcripts whose session header names the exact parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-child-history-'))
  roots.push(root)
  const parent = join(root, 'parent.jsonl')
  const childDirectory = join(root, 'parent')
  const child = join(childDirectory, 'worker.jsonl')
  const unrelated = join(childDirectory, 'unrelated.jsonl')
  await writeFile(parent, '{"type":"session","id":"parent"}\n')
  await mkdir(childDirectory)
  await writeFile(
    child,
    [
      JSON.stringify({ type: 'session', id: 'child', parentSession: parent }),
      JSON.stringify({
        type: 'message',
        id: 'answer',
        message: { role: 'assistant', content: [{ type: 'text', text: 'child output' }] }
      })
    ].join('\n')
  )
  await writeFile(
    unrelated,
    JSON.stringify({ type: 'session', id: 'other', parentSession: join(root, 'different.jsonl') })
  )
  const files = await readOmpSubagentHistoryFiles(parent)
  expect(files.map((file) => file.id)).toEqual(['worker'])
  expect(files[0]?.records[0]?.message).toMatchObject({ role: 'assistant' })
})
