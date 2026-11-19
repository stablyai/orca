import '../../claude/transcripts/claude-conversation-worker.test-fixture'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { placeChatForkImport } from './chat-fork-import-placement'

const UPLOADED = '00000000-0000-4000-8000-000000000001'
let root: string
let stagedPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-chat-fork-import-'))
  stagedPath = join(root, 'staged.jsonl')
  const fixture = await readFile(
    new URL('../../claude/__fixtures__/claude-rewind-hook.jsonl', import.meta.url),
    'utf8'
  )
  const rows = fixture
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .slice(0, 28)
  await writeFile(stagedPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

it('places an uploaded chat as a new chat in the target workspace’s Claude project', async () => {
  const home = join(root, 'claude-home')
  const placed = await placeChatForkImport(
    {
      filePath: stagedPath,
      sourceSessionId: UPLOADED,
      worktreeId: 'wt-target',
      workspacePath: '/work/target'
    },
    home
  )
  expect(placed.sessionId).not.toBe(UPLOADED)
  expect(placed.filePath).toBe(join(home, 'projects', '-work-target', `${placed.sessionId}.jsonl`))
  expect(placed).toMatchObject({ agent: 'claude', cwd: '/work/target', worktreeId: 'wt-target' })
  const entries = (await readFile(placed.filePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const withCwd = entries.filter((entry) => typeof entry.cwd === 'string')
  expect(withCwd.length).toBeGreaterThan(0)
  expect(withCwd.every((entry) => entry.cwd === '/work/target')).toBe(true)
  expect(
    entries
      .filter((entry) => typeof entry.sessionId === 'string')
      .every((entry) => entry.sessionId === placed.sessionId)
  ).toBe(true)
})
