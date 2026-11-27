import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../session-scanner'
import { isolatedScanRoots, jsonLines } from '../scanner-fixtures/session-scanner-test-fixtures'

const LIVE_ID = '019f0000-1111-7222-8333-444444444444'
const ARCHIVED_ID = '019f0000-5555-7666-8777-888888888888'
const RESUMED_ID = '019f0000-9999-7aaa-8bbb-cccccccccccc'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function rolloutRecords(sessionId: string, question: string, cwd: string): string {
  return jsonLines([
    {
      timestamp: '2026-05-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd }
    },
    {
      timestamp: '2026-05-01T10:00:05.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: question }
    },
    {
      timestamp: '2026-05-01T10:00:10.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: 'answer' }
    }
  ])
}

/** Codex moves an idle rollout flat into `archived_sessions` and compresses it (#51144). */
function archivedRolloutName(sessionId: string): string {
  return `rollout-2026-05-01T10-00-00-${sessionId}.jsonl`
}

function liveRolloutPath(
  sessionsDir: string,
  sessionId: string,
  day = ['2026', '05', '01']
): string {
  return join(sessionsDir, ...day, `rollout-2026-05-01T10-00-00-${sessionId}.jsonl`)
}

async function codexRoots() {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-archive-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const sessionsDir = roots.codexSessionsDir
  const archivedDir = join(root, 'archived_sessions')
  await mkdir(archivedDir, { recursive: true })
  return { roots, sessionsDir, archivedDir }
}

describe('scanAiVaultSessions — Codex archived rollouts', () => {
  it('lists a chat Codex archived and compressed out of the sessions tree', async () => {
    const { roots, sessionsDir, archivedDir } = await codexRoots()
    await mkdir(join(sessionsDir, '2026', '05', '01'), { recursive: true })
    await writeFile(
      liveRolloutPath(sessionsDir, LIVE_ID),
      rolloutRecords(LIVE_ID, 'live question', '/repo/app')
    )
    await writeFile(
      join(archivedDir, `${archivedRolloutName(ARCHIVED_ID)}.zst`),
      zstdCompressSync(
        Buffer.from(rolloutRecords(ARCHIVED_ID, 'archived question', '/repo/archived'))
      )
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(
      result.sessions
        .filter((session) => session.agent === 'codex')
        .map((session) => session.sessionId)
        .sort()
    ).toEqual([LIVE_ID, ARCHIVED_ID].sort())
  })

  it('counts a resumed archived rollout once, not once per Codex folder', async () => {
    // Resuming a chat leaves the compressed archive behind and restores the plain file beside it.
    const { roots, sessionsDir, archivedDir } = await codexRoots()
    const archived = join(archivedDir, `${archivedRolloutName(RESUMED_ID)}.zst`)
    await writeFile(
      archived,
      zstdCompressSync(Buffer.from(rolloutRecords(RESUMED_ID, 'resumed question', '/repo/app')))
    )
    // Only the restored file is canonical: the archive alone is a copy needing session-ID proof.
    await mkdir(join(sessionsDir, '2026', '05', '01'), { recursive: true })
    await writeFile(
      liveRolloutPath(sessionsDir, RESUMED_ID),
      rolloutRecords(RESUMED_ID, 'resumed question', '/repo/app')
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    const rows = result.sessions.filter((session) => session.sessionId === RESUMED_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0].filePath.endsWith('.jsonl')).toBe(true)
    // The archived copy folds into the restored row instead of being listed again.
    expect(result.sessions.map((session) => session.filePath)).not.toContain(archived)
  })

  it('reports no issues for a Codex home that never archived anything', async () => {
    const { roots, sessionsDir } = await codexRoots()
    await mkdir(join(sessionsDir, '2026', '05', '01'), { recursive: true })
    await writeFile(
      liveRolloutPath(sessionsDir, LIVE_ID),
      rolloutRecords(LIVE_ID, 'live question', '/repo/app')
    )
    await rm(join(roots.codexSessionsDir, '..', 'archived_sessions'), {
      recursive: true,
      force: true
    })

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.sessions.map((session) => session.sessionId)).toEqual([LIVE_ID])
    expect(result.issues.filter((issue) => issue.agent === 'codex')).toEqual([])
  })
})
