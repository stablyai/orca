import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from './parse-cache/session-scanner-parse-cache'
import {
  resetSessionParseCacheForTests,
  getSessionParseCacheEntry
} from './parse-cache/session-parse-cache-store'

import { aiVaultScanIssueText } from '../../shared/ai-vault/scanning/ai-vault-scan-issue-copy'
import { codexFixture } from './scanners/codex/session-scanner-codex-fixtures'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './transcripts/session-transcript-record-budget'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './parse-cache/session-parse-cache-persistence'
import { kiroTranscriptPathForMetadata } from '../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import type { SessionFileCandidate } from './session-scanner-types'

const SESSION_FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'
// One record past the budget, terminated separately so tests control the newline.
const OVERSIZED = Buffer.alloc(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1, 'x')

let tempRoots: string[] = []

afterEach(async () => {
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function record(text: string): string {
  return `${JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: text } })}\n`
}

async function candidate(path: string): Promise<SessionFileCandidate> {
  const info = await stat(path)
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: info.size
    }
  }
}

it('lists a recovered session without an issue on fresh and cached scans', async () => {
  const root = await tempRoot('orca-record-budget-scan-')
  const roots = isolatedScanRoots(root)
  const fixture = codexFixture()
  const dir = roots.codexSessionsDir
  const path = join(dir, fixture.fileName)

  await mkdir(dir, { recursive: true })
  await writeFile(path, `${fixture.seedLines.join('\n')}\n`)
  await appendFile(path, '{"type":"compacted","payload":{"message":"')
  await appendFile(path, OVERSIZED)
  await appendFile(path, `"}}\n${fixture.appendLines.join('\n')}\n`)

  for (let scan = 0; scan < 2; scan++) {
    const result = await scanAiVaultSessions(roots)
    const session = result.sessions.find((entry) => entry.filePath === path)
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'codex seed question',
      'codex seed answer',
      'codex follow-up',
      'codex incremental answer'
    ])
    expect(result.issues).toEqual([])
  }
})

it.each(['claude', 'kiro'] as const)(
  'retains %s unreadable errors across restart and clears them on recovery or replacement',
  async (agent) => {
    const root = await tempRoot('orca-record-budget-unreadable-')
    const dir = join(root, agent)
    const roots = {
      ...isolatedScanRoots(root),
      ...(agent === 'claude' ? { claudeProjectsDir: dir } : { kiroSessionsDir: dir })
    }
    const cacheFile = join(root, 'session-parse-cache.json')
    initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'test' })
    const path = join(
      dir,
      agent === 'claude' ? SESSION_FILE : SESSION_FILE.replace('.jsonl', '.json')
    )
    const transcript = agent === 'kiro' ? kiroTranscriptPathForMetadata(path) : path
    const emptyPath = join(
      dir,
      `bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.${agent === 'kiro' ? 'json' : 'jsonl'}`
    )
    const conversationalRecord = (text: string) =>
      agent === 'claude'
        ? record(text)
        : `${JSON.stringify({
            version: 'v1',
            kind: 'Prompt',
            data: { content: [{ kind: 'text', data: text }] }
          })}\n`
    const restart = async () => {
      await flushSessionParseCachePersist()
      resetSessionParseCacheForTests()
      resetSessionParseCachePersistenceForTests()
      initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'test' })
    }

    await mkdir(dir, { recursive: true })
    if (agent === 'kiro') {
      await writeFile(path, '{}')
    }
    await writeFile(transcript, conversationalRecord(OVERSIZED.toString()))
    await writeFile(emptyPath, agent === 'kiro' ? '{}' : '')

    const result = await scanAiVaultSessions(roots)
    expect(result.sessions.find((entry) => entry.filePath === path)?.messageCount).toBe(0)
    expect(result.sessions.find((entry) => entry.filePath === emptyPath)?.messageCount).toBe(0)
    expect(result.issues).toEqual([
      {
        executionHostId: 'local',
        agent,
        path,
        ...aiVaultScanIssueText('transcriptTooLarge', {
          params: { label: agent === 'claude' ? 'Claude' : 'Kiro' }
        })
      }
    ])
    const unchanged = await candidate(path)
    unchanged.agent = agent
    unchanged.file.sidecar = getSessionParseCacheEntry(path)?.sidecar
    await restart()
    const stats = createSessionParseStats()
    await parseAgentSessionFileCached(unchanged, process.platform, stats)
    expect(stats).toMatchObject({ reused: 1, fullParses: 0, incremental: 0, bytesRead: 0 })
    expect((await scanAiVaultSessions(roots)).issues).toEqual(result.issues)

    await appendFile(transcript, conversationalRecord('recovered question'))
    const recovered = await scanAiVaultSessions(roots)
    expect(
      recovered.sessions
        .find((entry) => entry.filePath === path)
        ?.previewMessages.map((message) => message.text)
    ).toEqual(['recovered question'])
    expect(recovered.issues).toEqual([])
    await restart()
    expect((await scanAiVaultSessions(roots)).issues).toEqual([])

    await writeFile(transcript, conversationalRecord(OVERSIZED.toString()))
    expect((await scanAiVaultSessions(roots)).issues).toEqual(result.issues)
    await writeFile(transcript, '')
    expect((await scanAiVaultSessions(roots)).issues).toEqual([])
    await restart()
    expect((await scanAiVaultSessions(roots)).issues).toEqual([])
  }
)
