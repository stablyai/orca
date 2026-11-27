import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as transcriptFilesystem from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import type { SessionFileCandidate } from '../session-scanner-types'
import { createSessionParseStats, parseAgentSessionFileCached } from './session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'

const filesystem = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  actualReaddir: vi.fn(),
  actualStat: vi.fn()
}))

// Real filesystem unless a test forces a failure, so the counts stay honest.
vi.mock('../../native-chat/transcript-filesystem/wsl-transcript-fs-access', async (original) => {
  const actual = await original<typeof transcriptFilesystem>()
  filesystem.actualReaddir.mockImplementation(actual.wslGatedReaddir)
  filesystem.actualStat.mockImplementation(actual.wslGatedStat)
  filesystem.readdir.mockImplementation(filesystem.actualReaddir)
  filesystem.stat.mockImplementation(filesystem.actualStat)
  return {
    ...actual,
    wslGatedReaddir: filesystem.readdir,
    wslGatedStat: filesystem.stat
  }
})

const PARENT_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
const AGENT_DIR = 'd4306da3-ab96-4236-bf98-8865dc4ce978'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
  filesystem.readdir.mockImplementation(filesystem.actualReaddir)
  filesystem.stat.mockImplementation(filesystem.actualStat)
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pi-subagent-reuse-'))
  tempRoots.push(root)
  return root
}

/** A Pi parent with turns: its own signature never moves, so only child directories can. */
async function writePiParentWithMessages(root: string): Promise<string> {
  const parentPath = join(root, `${PARENT_STEM}.jsonl`)
  await writeFile(
    parentPath,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'cccccccc-dddd-4eee-8fff-000000000000',
        cwd: '/repo/app'
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: 'Delegate the review' }
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: 'Delegated' }
      })
    ].join('\n')
  )
  return parentPath
}

/** A Pi parent with no turns: the case the zero-message recount used to cover. */
async function writePiParentWithoutMessages(root: string): Promise<string> {
  const parentPath = join(root, `${PARENT_STEM}.jsonl`)
  await writeFile(
    parentPath,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'cccccccc-dddd-4eee-8fff-000000000000',
      cwd: '/repo/app'
    })
  )
  return parentPath
}

/** A Claude parent without turns plus one subagent transcript beside it. */
async function writeClaudeParentWithoutMessages(root: string): Promise<string> {
  const projectDir = join(root, 'claude-projects', 'project')
  const transcriptPath = join(projectDir, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000.jsonl')
  await mkdir(join(projectDir, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000', 'subagents'), {
    recursive: true
  })
  await writeFile(transcriptPath, '')
  await writeFile(
    join(projectDir, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000', 'subagents', 'agent-1.jsonl'),
    ''
  )
  return transcriptPath
}

/** pi-subagents writes `<stem>/<agent>/run-N/session.jsonl`. */
async function writePiChild(
  root: string,
  agentDir: string,
  runDir: string,
  sessionId: string
): Promise<string> {
  const filePath = join(root, PARENT_STEM, agentDir, runDir, 'session.jsonl')
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(
    filePath,
    [
      JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: '/repo/app' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: `Task ${sessionId}` } })
    ].join('\n')
  )
  return filePath
}

async function parseSession(
  agent: SessionFileCandidate['agent'],
  path: string,
  stats = createSessionParseStats()
) {
  const fileStat = await stat(path)
  return parseAgentSessionFileCached(
    {
      agent,
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      },
      codexHome: null
    },
    process.platform,
    stats
  )
}

function parsePi(path: string, stats = createSessionParseStats()) {
  return parseSession('pi', path, stats)
}

describe('reused Pi subagent counts', () => {
  it('recounts when a nested child directory gains a transcript', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithMessages(root)
    await writePiChild(root, AGENT_DIR, 'run-0', 'child-1')
    const stats = createSessionParseStats()

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    // The first reuse stamps the directories it walked.
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    const stemMtimeMs = (await stat(join(root, PARENT_STEM))).mtimeMs

    // A second run lands under the agent directory, leaving the parent stem untouched.
    await writePiChild(root, AGENT_DIR, 'run-1', 'child-2')
    expect((await stat(join(root, PARENT_STEM))).mtimeMs).toBe(stemMtimeMs)

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(2)
    expect(stats.reused).toBe(2)
  })

  it('keeps the cached count without walking when every child directory is unchanged', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithMessages(root)
    await writePiChild(root, AGENT_DIR, 'run-0', 'child-1')
    const stats = createSessionParseStats()

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    const walksAfterStamping = filesystem.readdir.mock.calls.length
    const stamps = filesystem.stat.mock.calls.length

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)

    // One stat per visited directory: the stem, the agent directory, and its run directory.
    expect(filesystem.readdir.mock.calls.length).toBe(walksAfterStamping)
    expect(filesystem.stat.mock.calls.length - stamps).toBe(3)
    expect(stats.reused).toBe(2)
  })

  it('costs one stat to reuse a parent that never delegated', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithMessages(root)
    const stats = createSessionParseStats()

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(0)
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(0)
    const walksAfterStamping = filesystem.readdir.mock.calls.length
    const stamps = filesystem.stat.mock.calls.length

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(0)

    // The absent stem directory is the only stamp it has to check.
    expect(filesystem.readdir.mock.calls.length).toBe(walksAfterStamping)
    expect(filesystem.stat.mock.calls.length - stamps).toBe(1)
  })

  it('keeps its stamps when the parent transcript is reparsed', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithMessages(root)
    await writePiChild(root, AGENT_DIR, 'run-0', 'child-1')
    const stats = createSessionParseStats()

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)

    // The parent grows, so its next parse is a resume rather than a reuse.
    await writeFile(
      parentPath,
      `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'And review it' } })}\n`,
      { flag: 'a' }
    )
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    const walksAfterReparse = filesystem.readdir.mock.calls.length
    const stamps = filesystem.stat.mock.calls.length

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)

    // A reparse carries the stamps it had, so reuse still skips the walk.
    expect(filesystem.readdir.mock.calls.length).toBe(walksAfterReparse)
    expect(filesystem.stat.mock.calls.length - stamps).toBe(3)
  })

  it('recounts when a directory that read as absent comes back', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithMessages(root)
    await writePiChild(root, AGENT_DIR, 'run-0', 'child-1')
    const stats = createSessionParseStats()

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    // The stem is renamed away between its stamp and its read, so the walk reports no children.
    filesystem.readdir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(0)

    // It is back with its children; a stamp taken before the absence must not vouch for the zero.
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
  })

  it('reuses a zero-message parent without walking once its directories are stamped', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithoutMessages(root)
    await writePiChild(root, AGENT_DIR, 'run-0', 'child-1')
    const stats = createSessionParseStats()

    const seeded = await parsePi(parentPath, stats)
    expect(seeded?.messageCount).toBe(0)
    expect(seeded?.subagentTranscriptCount).toBe(1)
    // The first reuse stamps the directories it walked.
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    const walksAfterStamping = filesystem.readdir.mock.calls.length
    const stamps = filesystem.stat.mock.calls.length

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)

    expect(filesystem.readdir.mock.calls.length).toBe(walksAfterStamping)
    expect(filesystem.stat.mock.calls.length - stamps).toBe(3)
  })

  it('walks again when a child directory cannot be stamped, and never zeroes a failed read', async () => {
    const root = await makeTempDir()
    const parentPath = await writePiParentWithMessages(root)
    await writePiChild(root, AGENT_DIR, 'run-0', 'child-1')
    const stats = createSessionParseStats()

    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(1)
    await writePiChild(root, AGENT_DIR, 'run-1', 'child-2')

    // A stat that cannot vouch for a directory must not keep the stored count.
    const stemDir = join(root, PARENT_STEM)
    filesystem.stat.mockImplementation((path: string, ...rest: unknown[]) =>
      path.startsWith(stemDir)
        ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
        : filesystem.actualStat(path, ...rest)
    )
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(2)

    // A failed walk proves nothing either: the count it could not read is not zero.
    filesystem.readdir.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
    )
    expect((await parsePi(parentPath, stats))?.subagentTranscriptCount).toBe(2)
  })
})

describe('reused Claude subagent counts', () => {
  it('still recounts a zero-message parent on every reuse', async () => {
    const root = await makeTempDir()
    const transcriptPath = await writeClaudeParentWithoutMessages(root)
    const stats = createSessionParseStats()

    const seeded = await parseSession('claude', transcriptPath, stats)
    expect(seeded?.agent).toBe('claude')
    expect(seeded?.messageCount).toBe(0)
    expect(seeded?.subagentTranscriptCount).toBe(1)

    // Claude has no signature, so each reuse reads the sibling transcript directory again.
    const walksBeforeFirstReuse = filesystem.readdir.mock.calls.length
    expect((await parseSession('claude', transcriptPath, stats))?.subagentTranscriptCount).toBe(1)
    const walksBeforeSecondReuse = filesystem.readdir.mock.calls.length
    expect(walksBeforeSecondReuse).toBeGreaterThan(walksBeforeFirstReuse)

    expect((await parseSession('claude', transcriptPath, stats))?.subagentTranscriptCount).toBe(1)
    expect(filesystem.readdir.mock.calls.length).toBeGreaterThan(walksBeforeSecondReuse)
    expect(stats.reused).toBe(2)
  })
})
