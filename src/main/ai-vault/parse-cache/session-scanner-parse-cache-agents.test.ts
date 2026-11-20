import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentSessionFile } from '../parsing/session-scanner-agent-parser'
import {
  CODEX_FIXTURE_SESSION_ID,
  codexFixture
} from '../scanners/codex/session-scanner-codex-fixtures'
import { jsonLines } from '../scanner-fixtures/session-scanner-test-fixtures'
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

describe('pi subagent counts', () => {
  it('recounts the children of a reused parent that already has messages', async () => {
    const root = await makeTempDir()
    const stem = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
    const parentPath = join(root, `${stem}.jsonl`)
    const childDir = join(root, stem, 'd4306da3-ab96-4236-bf98-8865dc4ce978', 'run-0')
    await mkdir(childDir, { recursive: true })
    await writeFile(
      parentPath,
      jsonLines([
        { type: 'session', version: 3, id: 'cccccccc-dddd-4eee-8fff-000000000000', cwd: '/repo' },
        { type: 'message', message: { role: 'user', content: 'Delegate the review' } },
        { type: 'message', message: { role: 'assistant', content: 'Delegated' } }
      ])
    )
    const childTranscript = (id: string, prompt: string): string =>
      jsonLines([
        { type: 'session', version: 3, id, cwd: '/repo', parentSession: parentPath },
        { type: 'message', message: { role: 'user', content: prompt } }
      ])
    await writeFile(
      join(childDir, 'session.jsonl'),
      childTranscript('child-1', 'Map the auth surface')
    )

    const stats = createSessionParseStats()
    const seeded = await parseAgentSessionFileCached(
      await candidateFor('pi', parentPath),
      process.platform,
      stats
    )
    expect(seeded?.subagentTranscriptCount).toBe(1)

    // Children arrive beside the parent file, so its own signature never changes.
    const laterChildDir = join(root, stem, '4684f05a-d72d-4cdf-9e88-0adc2d16a31c', 'run-0')
    await mkdir(laterChildDir, { recursive: true })
    await writeFile(
      join(laterChildDir, 'session.jsonl'),
      childTranscript('child-2', 'Read the DC API spec')
    )

    const recounted = await parseAgentSessionFileCached(
      await candidateFor('pi', parentPath),
      process.platform,
      stats
    )
    expect(stats.reused).toBe(1)
    expect(recounted?.subagentTranscriptCount).toBe(2)
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
