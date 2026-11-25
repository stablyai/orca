import { copyFile, link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { isSnapshotOfSource } from './structured-agent-session-create-adoption'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-adoption-snapshot-'))
  await writeFile(join(dir, 'source.jsonl'), '{"type":"session_meta"}\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// A closing pane's live writer may only be admitted when the chat reads the same file it appends to.
it('treats a hard-linked rollout as live and a copied one as a snapshot', async () => {
  const source = join(dir, 'source.jsonl')
  await link(source, join(dir, 'linked.jsonl'))
  await copyFile(source, join(dir, 'copied.jsonl'))

  expect(await isSnapshotOfSource(source, source)).toBe(false)
  expect(await isSnapshotOfSource(source, join(dir, 'linked.jsonl'))).toBe(false)
  expect(await isSnapshotOfSource(source, join(dir, 'copied.jsonl'))).toBe(true)
})
