import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import {
  CODEX_FIXTURE_SESSION_ID,
  codexFixture,
  codexWorkerFixtureLines
} from './session-scanner-codex-fixtures'
import { allIncrementalAgentFixtures } from './session-scanner-incremental-fixtures'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'
import { TRAE_FIXTURE_SESSION_ID, traeFixture } from './session-scanner-trae-fixtures'

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-parse-cache-agents-'))
  tempRoots.push(root)
  return root
}

async function candidateFor(
  agent: SessionFileCandidate['agent'],
  path: string,
  codexHome: string | null = null
): Promise<SessionFileCandidate> {
  const fileStat = await stat(path)
  return {
    agent,
    file: {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size
    },
    codexHome
  }
}

describe.each(allIncrementalAgentFixtures())('incremental parse parity: $agent', (fixture) => {
  it('reuses unchanged files, resumes appends, and matches cold parses exactly', async () => {
    const root = await makeTempDir()
    const path = join(root, fixture.fileName)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${fixture.seedLines.join('\n')}\n`)

    const stats = createSessionParseStats()
    const seedCandidate = await candidateFor(fixture.agent, path)
    const seeded = await parseAgentSessionFileCached(seedCandidate, process.platform, stats)
    expect(stats.fullParses).toBe(1)
    expect(seeded).toEqual(await parseAgentSessionFile(seedCandidate, process.platform))

    // Unchanged rescan returns the identical cached object.
    const reused = await parseAgentSessionFileCached(seedCandidate, process.platform, stats)
    expect(reused).toBe(seeded)
    expect(stats.reused).toBe(1)

    // Appended lines resume from the stored byte offset and must equal a
    // cold parse of the grown file.
    await appendFile(path, `${fixture.appendLines.join('\n')}\n`)
    const grownCandidate = await candidateFor(fixture.agent, path)
    const incremental = await parseAgentSessionFileCached(grownCandidate, process.platform, stats)
    expect(stats.incremental).toBe(1)
    expect(incremental).toEqual(await parseAgentSessionFile(grownCandidate, process.platform))

    // A truncated rewrite falls back to a full parse.
    await writeFile(path, `${fixture.truncatedLines.join('\n')}\n`)
    const truncatedCandidate = await candidateFor(fixture.agent, path)
    const reparsed = await parseAgentSessionFileCached(truncatedCandidate, process.platform, stats)
    expect(stats.fullParses).toBe(2)
    expect(reparsed).toEqual(await parseAgentSessionFile(truncatedCandidate, process.platform))
  })

  it('includes a trailing unterminated line without double-counting it later', async () => {
    const root = await makeTempDir()
    const path = join(root, fixture.fileName)
    await mkdir(dirname(path), { recursive: true })
    const lastSeedLine = fixture.seedLines.at(-1)
    const headLines = fixture.seedLines.slice(0, -1)
    await writeFile(path, `${[...headLines, ''].join('\n')}${lastSeedLine}`)

    const partialCandidate = await candidateFor(fixture.agent, path)
    const shown = await parseAgentSessionFileCached(partialCandidate, process.platform)
    expect(shown).toEqual(await parseAgentSessionFile(partialCandidate, process.platform))

    await appendFile(path, `\n${fixture.appendLines.join('\n')}\n`)
    const grownCandidate = await candidateFor(fixture.agent, path)
    const stats = createSessionParseStats()
    const completed = await parseAgentSessionFileCached(grownCandidate, process.platform, stats)
    expect(stats.incremental).toBe(1)
    expect(completed).toEqual(await parseAgentSessionFile(grownCandidate, process.platform))
  })

  it('tolerates a mid-write truncated trailing line and never double-counts it', async () => {
    const root = await makeTempDir()
    const path = join(root, fixture.fileName)
    await mkdir(dirname(path), { recursive: true })
    // A writer caught mid-record: the trailing line is invalid JSON.
    await writeFile(path, `${fixture.seedLines.join('\n')}\n{"type":"user","mess`)

    const shown = await parseAgentSessionFileCached(
      await candidateFor(fixture.agent, path),
      process.platform
    )
    expect(shown).toEqual(
      await parseAgentSessionFile(await candidateFor(fixture.agent, path), process.platform)
    )

    // The writer "finishes" the interrupted record as unparseable junk (both
    // the fold and a cold parse must skip it identically) and appends more.
    await appendFile(path, `age": }\n${fixture.appendLines.join('\n')}\n`)
    const stats = createSessionParseStats()
    const completed = await parseAgentSessionFileCached(
      await candidateFor(fixture.agent, path),
      process.platform,
      stats
    )
    expect(stats.incremental).toBe(1)
    expect(completed).toEqual(
      await parseAgentSessionFile(await candidateFor(fixture.agent, path), process.platform)
    )
  })
})

describe('rollout-specific resume behavior', () => {
  it('keeps the original Trae cwd when an appended turn context uses another directory', async () => {
    const root = await makeTempDir()
    const path = join(root, `rollout-${TRAE_FIXTURE_SESSION_ID}.jsonl`)
    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: { cwd: '/repo/original' }
      })}\n${JSON.stringify({
        timestamp: '2026-08-10T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Keep the original workspace' }
      })}\n`
    )
    const seededCandidate = await candidateFor('trae', path)
    expect((await parseAgentSessionFileCached(seededCandidate, process.platform))?.cwd).toBe(
      '/repo/original'
    )

    await appendFile(
      path,
      `${JSON.stringify({
        timestamp: '2026-08-10T10:01:00.000Z',
        type: 'turn_context',
        payload: { cwd: '/repo/later-turn' }
      })}\n`
    )
    const stats = createSessionParseStats()
    const appended = await parseAgentSessionFileCached(
      await candidateFor('trae', path),
      process.platform,
      stats
    )
    expect(stats.incremental).toBe(1)
    expect(appended).toMatchObject({
      cwd: '/repo/original',
      resumeCommand: "cd '/repo/original' && traecli resume '019fe968-ff04-7e43-8316-983ae577b782'"
    })
  })

  it('keeps rejecting worker sessions across incremental appends', async () => {
    const root = await makeTempDir()
    const path = join(root, codexFixture().fileName)
    await writeFile(path, `${codexWorkerFixtureLines().join('\n')}\n`)

    const stats = createSessionParseStats()
    const seeded = await parseAgentSessionFileCached(
      await candidateFor('codex', path),
      process.platform,
      stats
    )
    expect(seeded).toBeNull()

    await appendFile(
      path,
      `${JSON.stringify({
        timestamp: '2026-05-01T10:10:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'worker keeps writing' }
      })}\n`
    )
    const grown = await parseAgentSessionFileCached(
      await candidateFor('codex', path),
      process.platform,
      stats
    )
    expect(stats.incremental).toBe(1)
    expect(grown).toBeNull()
  })

  it('picks up a session_index title that appears after the transcript was cached', async () => {
    const root = await makeTempDir()
    const codexHome = join(root, 'codex-home')
    const sessionsDir = join(codexHome, 'sessions', '2026', '05', '01')
    await mkdir(sessionsDir, { recursive: true })
    const fixture = codexFixture()
    const path = join(sessionsDir, fixture.fileName)
    await writeFile(path, `${fixture.seedLines.join('\n')}\n`)

    // No index yet: the title falls back to the first user prompt.
    const seeded = await parseAgentSessionFileCached(
      await candidateFor('codex', path, codexHome),
      process.platform
    )
    expect(seeded?.title).toBe('codex seed question')

    // Codex names the thread lazily; an unchanged transcript must still adopt it.
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Indexed thread title' })}\n`
    )
    const stats = createSessionParseStats()
    const renamed = await parseAgentSessionFileCached(
      await candidateFor('codex', path, codexHome),
      process.platform,
      stats
    )
    expect(stats.reused).toBe(1)
    expect(renamed?.title).toBe('Indexed thread title')
    expect(renamed).toEqual(
      await parseAgentSessionFile(await candidateFor('codex', path, codexHome), process.platform)
    )
  })

  it('refreshes a cached Trae title without re-reading the transcript', async () => {
    const root = await makeTempDir()
    const traeHome = join(root, '.trae', 'cli')
    const sessionsDir = join(traeHome, 'sessions', '2026', '08', '10')
    await mkdir(sessionsDir, { recursive: true })
    const fixture = traeFixture()
    const path = join(sessionsDir, fixture.fileName)
    await writeFile(path, `${fixture.seedLines.join('\n')}\n`)

    const candidate = await candidateFor('trae', path)
    const seeded = await parseAgentSessionFileCached(candidate, process.platform)
    expect(seeded?.title).toBe('Trae seed question')

    await writeFile(
      join(traeHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: TRAE_FIXTURE_SESSION_ID, thread_name: 'Indexed Trae title' })}\n`
    )
    const stats = createSessionParseStats()
    const renamed = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(stats.reused).toBe(1)
    expect(renamed?.title).toBe('Indexed Trae title')
    expect(renamed).toEqual(await parseAgentSessionFile(candidate, process.platform))
  })

  it.each([
    { agent: 'codex' as const, sessionId: CODEX_FIXTURE_SESSION_ID },
    { agent: 'trae' as const, sessionId: TRAE_FIXTURE_SESSION_ID }
  ])('keeps $agent metadata titles when an unchanged cache entry is reused', async (fixture) => {
    const root = await makeTempDir()
    const sessionHome = join(root, fixture.agent === 'codex' ? '.codex' : '.trae', 'cli')
    const sessionsDir = join(sessionHome, 'sessions', '2026', '08', '10')
    await mkdir(sessionsDir, { recursive: true })
    const path = join(sessionsDir, `rollout-${fixture.sessionId}.jsonl`)
    await writeFile(
      path,
      `${JSON.stringify({
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: fixture.sessionId, cwd: '/repo/original', title: 'Metadata title' }
      })}\n`
    )
    const candidate = await candidateFor(
      fixture.agent,
      path,
      fixture.agent === 'codex' ? sessionHome : null
    )

    expect((await parseAgentSessionFileCached(candidate, process.platform))?.title).toBe(
      'Metadata title'
    )
    await writeFile(
      join(sessionHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: fixture.sessionId, thread_name: 'Conflicting index title' })}\n`
    )

    const stats = createSessionParseStats()
    const reused = await parseAgentSessionFileCached(candidate, process.platform, stats)
    expect(stats.reused).toBe(1)
    expect(reused?.title).toBe('Metadata title')

    const persisted = snapshotSessionParseCacheForPersistence()
    resetSessionParseCacheForTests()
    seedSessionParseCache(persisted)
    const restartedStats = createSessionParseStats()
    const restarted = await parseAgentSessionFileCached(candidate, process.platform, restartedStats)
    expect(restartedStats.reused).toBe(1)
    expect(restarted?.title).toBe('Metadata title')
  })
})

describe('non-resumable formats keep reuse-only caching', () => {
  it('re-parses a changed grok summary fully and reuses it when unchanged', async () => {
    const root = await makeTempDir()
    const sessionDir = join(root, 'session-1')
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, 'summary.json')
    await writeFile(
      path,
      JSON.stringify({
        session_id: 'grok-1',
        title: 'Grok seed',
        updated_at: '2026-05-01T10:00:00Z'
      })
    )

    const stats = createSessionParseStats()
    const seeded = await parseAgentSessionFileCached(
      await candidateFor('grok', path),
      process.platform,
      stats
    )
    const reused = await parseAgentSessionFileCached(
      await candidateFor('grok', path),
      process.platform,
      stats
    )
    expect(reused).toBe(seeded)
    expect(stats).toMatchObject({ fullParses: 1, reused: 1, incremental: 0 })

    await writeFile(
      path,
      JSON.stringify({
        session_id: 'grok-1',
        title: 'Grok rewritten with a longer title',
        updated_at: '2026-05-01T11:00:00Z'
      })
    )
    const rewritten = await parseAgentSessionFileCached(
      await candidateFor('grok', path),
      process.platform,
      stats
    )
    expect(stats).toMatchObject({ fullParses: 2, incremental: 0 })
    expect(rewritten).toEqual(
      await parseAgentSessionFile(await candidateFor('grok', path), process.platform)
    )
  })
})
