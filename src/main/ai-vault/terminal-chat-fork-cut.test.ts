import '../claude/transcripts/claude-conversation-worker.test-fixture'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { copyTerminalChatForkCut } from './terminal-chat-fork-cut'

const SOURCE = '00000000-0000-4000-8000-000000000001'
let root: string
let sourcePath: string
let rows: Record<string, unknown>[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-terminal-fork-'))
  const project = join(root, 'projects', '-repo-feature')
  await mkdir(project, { recursive: true })
  sourcePath = join(project, `${SOURCE}.jsonl`)
  const fixture = await readFile(
    new URL('../claude/__fixtures__/claude-rewind-hook.jsonl', import.meta.url),
    'utf8'
  )
  rows = fixture
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .slice(0, 28)
  await writeFile(sourcePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

it('copies a terminal chat up to one reply into the other worktree’s Claude project', async () => {
  const reply = rows.findLast((row) => row.type === 'assistant')!
  const result = await copyTerminalChatForkCut({
    agent: 'claude',
    sessionId: SOURCE,
    filePath: sourcePath,
    codexHome: null,
    executionHostId: 'local',
    fork: true,
    forkThroughEntryId: String(reply.uuid),
    destinationCwd: '/repo/feature-fork'
  })
  const forked = result?.forkedSession
  expect(forked?.agent).toBe('claude')
  expect(forked?.sessionId).not.toBe(SOURCE)
  expect(forked?.filePath).toBe(
    join(root, 'projects', '-repo-feature-fork', `${forked?.sessionId}.jsonl`)
  )
  const copied = (await readFile(forked!.filePath!, 'utf8')).trim().split('\n')
  expect(copied.some((line) => line.includes(String(reply.uuid)))).toBe(true)
})

it('leaves a fork without a cut to the ordinary path', async () => {
  await expect(
    copyTerminalChatForkCut({
      agent: 'claude',
      sessionId: SOURCE,
      filePath: sourcePath,
      codexHome: null,
      executionHostId: 'local',
      fork: true
    })
  ).resolves.toBeNull()
})
