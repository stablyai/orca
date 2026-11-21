import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentSessionFile } from '../parsing/session-scanner-agent-parser'
import {
  CODEX_FIXTURE_SESSION_ID,
  codexFixture
} from '../scanners/codex/session-scanner-codex-fixtures'
import { createSessionParseStats, parseAgentSessionFileCached } from './session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'
import type { SessionFileCandidate } from '../session-scanner-types'

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

describe('codex-specific resume behavior', () => {
  it('picks up a session_index title that appears after the transcript was cached', async () => {
    const root = await makeTempDir()
    const codexHome = join(root, 'codex-home')
    const sessionsDir = join(codexHome, 'sessions', '2026', '05', '01')
    await mkdir(sessionsDir, { recursive: true })
    const fixture = codexFixture()
    const path = join(sessionsDir, fixture.fileName)
    await writeFile(path, `${fixture.seedLines.join('\n')}\n`)

    const seeded = await parseAgentSessionFileCached(
      await candidateFor('codex', path, codexHome),
      process.platform
    )
    expect(seeded?.title).toBe('codex seed question')
    expect(seeded?.titleKind).toBe('fallback')

    // Index titles arrive independently of transcript writes.
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
    expect(renamed?.titleKind).toBe('named')
    expect(renamed).toEqual(
      await parseAgentSessionFile(await candidateFor('codex', path, codexHome), process.platform)
    )
  })
})

describe('non-resumable formats keep reuse-only caching', () => {
  it('re-parses cline when only its messages sidecar changed', async () => {
    const root = await makeTempDir()
    const sessionDir = join(root, 'cline-1')
    await mkdir(sessionDir, { recursive: true })
    const metadataPath = join(sessionDir, 'cline-1.json')
    const messagesPath = join(sessionDir, 'cline-1.messages.json')
    await writeFile(
      metadataPath,
      JSON.stringify({
        session_id: 'cline-1',
        cwd: '/tmp/cline',
        started_at: '2026-05-01T10:00:00Z'
      })
    )
    const writeMessages = (text: string): Promise<void> =>
      writeFile(
        messagesPath,
        JSON.stringify({
          updated_at: '2026-05-01T10:00:01Z',
          messages: [{ role: 'user', content: [{ type: 'text', text }] }]
        })
      )
    await writeMessages('first ask')

    // Cline folds message sidecars during parsing, so sidecar changes require a full reparse.
    const candidate = async (): Promise<SessionFileCandidate> => {
      const base = await candidateFor('cline', metadataPath)
      const sidecarStat = await stat(messagesPath)
      return {
        ...base,
        file: {
          ...base.file,
          sidecar: {
            path: messagesPath,
            mtimeMs: sidecarStat.mtimeMs,
            sizeBytes: sidecarStat.size
          }
        }
      }
    }

    const stats = createSessionParseStats()
    const seeded = await parseAgentSessionFileCached(await candidate(), process.platform, stats)
    expect(seeded?.title).toBe('first ask')
    await parseAgentSessionFileCached(await candidate(), process.platform, stats)
    expect(stats).toMatchObject({ fullParses: 1, reused: 1 })

    await writeMessages('second ask, rather longer than the first')
    const rewritten = await parseAgentSessionFileCached(await candidate(), process.platform, stats)

    expect(rewritten?.title).toBe('second ask, rather longer than the first')
    expect(stats).toMatchObject({ fullParses: 2, reused: 1 })
  })
})
