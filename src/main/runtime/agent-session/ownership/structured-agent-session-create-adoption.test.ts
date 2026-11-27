import { appendFile, copyFile, link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  assertAdoptedSnapshotCurrent,
  isSnapshotOfSource
} from './structured-agent-session-create-adoption'

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

it('refuses an adopted copy when the source changes before the writer gate finishes', async () => {
  const source = join(dir, 'source.jsonl')
  const copied = join(dir, 'copied.jsonl')
  await copyFile(source, copied)

  await expect(
    assertAdoptedSnapshotCurrent({
      sourcePath: source,
      preparedPath: copied,
      writerGate: async () => {}
    })
  ).resolves.toBeUndefined()

  await expect(
    assertAdoptedSnapshotCurrent({
      sourcePath: source,
      preparedPath: copied,
      writerGate: async () => {
        await appendFile(source, '{"type":"event_msg"}\n')
      }
    })
  ).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' }
    }
  })
})
