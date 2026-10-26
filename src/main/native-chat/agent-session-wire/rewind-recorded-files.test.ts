import { mkdtemp, readFile, rm, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPatch } from 'diff'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  applyRecordedFileRewind,
  prepareRecordedFileRewind,
  undoRecordedFileRewind
} from './rewind-recorded-files'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-files-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function edit(path: string, before: string, after: string): AgentJournalRenderItem {
  const patch = createPatch(path, before, after)
  return {
    itemId: path,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'diff',
      state: 'completed',
      path,
      patch: { head: patch, byteLength: Buffer.byteLength(patch), digest: '', truncated: false }
    }
  }
}

it('reverses only recorded edits, keeps another file, and safely replays after restart', async () => {
  await writeFile(join(root, 'a.txt'), 'three\n')
  await writeFile(join(root, 'other.txt'), 'another agent\n')
  const plan = await prepareRecordedFileRewind(root, [
    edit('a.txt', 'one\n', 'two\n'),
    edit('a.txt', 'two\n', 'three\n')
  ])
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three\n')
  await applyRecordedFileRewind(plan)
  await applyRecordedFileRewind(JSON.parse(JSON.stringify(plan)))
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n')
  expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('another agent\n')
  await undoRecordedFileRewind(plan)
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('three\n')
})

it('checks every file before writing any when an edit happened after preview', async () => {
  await writeFile(join(root, 'a.txt'), 'after\n')
  await writeFile(join(root, 'b.txt'), 'after\n')
  const plan = await prepareRecordedFileRewind(root, [
    edit('a.txt', 'before\n', 'after\n'),
    edit('b.txt', 'before\n', 'after\n')
  ])
  await writeFile(join(root, 'a.txt'), 'other agent\n')
  await expect(applyRecordedFileRewind(plan)).rejects.toThrow('changed since confirmation')
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('after\n')
})

it('refuses a conflicting patch without changing the workspace', async () => {
  await writeFile(join(root, 'a.txt'), 'other agent\n')
  await expect(
    prepareRecordedFileRewind(root, [edit('a.txt', 'before\n', 'after\n')])
  ).rejects.toThrow('conflict')
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('other agent\n')
})

it('does not cross a workspace boundary or a symbolic link', async () => {
  await expect(prepareRecordedFileRewind(root, [edit('../outside', 'a\n', 'b\n')])).rejects.toThrow(
    'outside'
  )
  await writeFile(join(root, 'target'), 'b\n')
  await symlink(join(root, 'target'), join(root, 'link'))
  await expect(prepareRecordedFileRewind(root, [edit('link', 'a\n', 'b\n')])).rejects.toThrow(
    'unsupported file'
  )
  expect(await readFile(join(root, 'target'), 'utf8')).toBe('b\n')
})

it('refuses truncated records and tools without file recovery evidence', async () => {
  const truncated = edit('a', 'a\n', 'b\n')
  if (truncated.body.kind === 'diff') {
    truncated.body.patch.truncated = true
  }
  await expect(prepareRecordedFileRewind(root, [truncated])).rejects.toThrow('truncated')
  await expect(
    prepareRecordedFileRewind(root, [
      {
        ...truncated,
        body: {
          kind: 'tool-call',
          name: 'Bash',
          input: { command: 'anything' },
          state: 'completed'
        }
      }
    ])
  ).rejects.toThrow('without complete')
})

it('requires proof that the provider completed the file edit', async () => {
  await writeFile(join(root, 'a.txt'), 'after\n')
  const pending = edit('a.txt', 'before\n', 'after\n')
  if (pending.body.kind === 'diff') {
    pending.body.state = 'failed'
  }
  await expect(prepareRecordedFileRewind(root, [pending])).rejects.toThrow(
    'completion was not recorded'
  )
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after\n')
})

it('restores a deleted file and removes an explicitly recorded new file', async () => {
  const added = edit('new.txt', '', 'new content\n')
  const deleted = edit('gone.txt', 'old content\n', '')
  if (added.body.kind === 'diff') {
    added.body.patch.head = added.body.patch.head.replace('--- new.txt', '--- /dev/null')
  }
  if (deleted.body.kind === 'diff') {
    deleted.body.patch.head = `deleted file mode 100644\n${deleted.body.patch.head.replace('+++ gone.txt', '+++ /dev/null')}`
  }
  await writeFile(join(root, 'new.txt'), 'new content\n')
  const plan = await prepareRecordedFileRewind(root, [added, deleted])
  await applyRecordedFileRewind(plan)
  expect(await readFile(join(root, 'gone.txt'), 'utf8')).toBe('old content\n')
  await expect(readFile(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await undoRecordedFileRewind(plan)
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new content\n')
  await expect(readFile(join(root, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps unrelated later edits outside the recorded patch hunks', async () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index}\n`).join('')
  const after = before.replace('line 1\n', 'this session\n')
  const current = after.replace('line 29\n', 'other session\n')
  await writeFile(join(root, 'a.txt'), current)
  await applyRecordedFileRewind(
    await prepareRecordedFileRewind(root, [edit('a.txt', before, after)])
  )
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(
    before.replace('line 29\n', 'other session\n')
  )
})

it('resumes a guarded rename interrupted before publication', async () => {
  await writeFile(join(root, 'a.txt'), 'after\n')
  const plan = await prepareRecordedFileRewind(root, [edit('a.txt', 'before\n', 'after\n')])
  await rename(join(root, 'a.txt'), join(root, 'a.txt.orca-guarded'))
  await applyRecordedFileRewind(plan, true)
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before\n')
  await expect(readFile(join(root, 'a.txt.orca-guarded'))).rejects.toMatchObject({ code: 'ENOENT' })
})
