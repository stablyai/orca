import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { parseOpenCodeUsageRow } from './opencode-usage-row-parsing'
import { selectUsageRows } from './opencode-usage-row-queries'
import {
  OPENCODE_USAGE_FIXTURE_EPOCH_MS,
  writeOpenCodeUsageDatabase,
  type OpenCodeUsageFixtureSpec
} from './opencode-usage-sqlite-fixture'
import { parseOpenCodeUsageDatabase } from './scanner'

// Why: OpenCode 2 copies v1 `session` rows into `session_v2` and then writes
// only there. A reader that knows just `session` reports zero usage for every
// OpenCode 2 session, and a reader that unions both double-counts the migrated
// ones (#15841). These tests pin both halves against the real v2 schema.

const WORKTREE = '/workspace/repo'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createFixture(spec: OpenCodeUsageFixtureSpec): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode2-usage-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  writeOpenCodeUsageDatabase(path, spec)
  return path
}

function readEvents(dbPath: string) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return selectUsageRows(db).flatMap((row) => parseOpenCodeUsageRow(row) ?? [])
  } finally {
    db.close()
  }
}

async function worktreeResolver() {
  return createUsageWorktreeResolver([
    {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/workspace/repo',
      path: WORKTREE,
      displayName: 'Repo'
    }
  ])
}

describe('OpenCode 2 session_v2 usage', () => {
  it('reads sessions that exist only in session_v2', () => {
    const path = createFixture({
      generation: 'v2-only',
      v2Sessions: [
        {
          id: 'ses_v2_1',
          directory: WORKTREE,
          cost: 0.5,
          tokensInput: 100,
          tokensOutput: 20,
          tokensReasoning: 5,
          tokensCacheRead: 900,
          tokensCacheWrite: 300
        }
      ]
    })

    expect(readEvents(path)).toEqual([
      expect.objectContaining({
        sessionId: 'ses_v2_1',
        cwd: WORKTREE,
        model: 'anthropic/claude-sonnet-4-5',
        estimatedCostUsd: 0.5,
        inputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        cachedInputTokens: 900,
        totalTokens: 1325
      })
    ])
  })

  it('includes cache read and cache write tokens in the session total', () => {
    const path = createFixture({
      generation: 'v2-only',
      v2Sessions: [
        {
          id: 'ses_cache',
          directory: WORKTREE,
          tokensInput: 10,
          tokensOutput: 1,
          tokensCacheRead: 5_000,
          tokensCacheWrite: 2_000
        }
      ]
    })

    const [event] = readEvents(path)
    expect(event?.cachedInputTokens).toBe(5_000)
    // Cache writes are not billed as input, so they only reach the total.
    expect(event?.totalTokens).toBe(7_011)
  })

  it('counts a migrated session once, from session_v2', () => {
    const shared = {
      id: 'ses_shared',
      directory: WORKTREE,
      tokensInput: 100,
      tokensCacheRead: 40
    }
    const path = createFixture({
      generation: 'migrated',
      // The frozen pre-upgrade copy, still carrying the smaller snapshot totals.
      legacySessions: [shared],
      v2Sessions: [
        { ...shared, tokensInput: 180, tokensCacheRead: 60 },
        { id: 'ses_v2_only', directory: WORKTREE, tokensInput: 7 }
      ]
    })

    const events = readEvents(path)
    expect(events.map((event) => event.sessionId)).toEqual(['ses_shared', 'ses_v2_only'])
    expect(events[0]?.inputTokens).toBe(180)
    expect(events[0]?.cachedInputTokens).toBe(60)
  })

  it('keeps the legacy totals when session_v2 lacks the token columns', () => {
    const path = createFixture({
      generation: 'migrated',
      v2WithoutTokenColumns: true,
      legacySessions: [{ id: 'ses_shared', directory: WORKTREE, tokensInput: 1000, cost: 5 }],
      v2Sessions: [{ id: 'ses_shared', directory: WORKTREE }]
    })

    const events = readEvents(path)
    expect(events.map((event) => event.sessionId)).toEqual(['ses_shared'])
    expect(events[0]?.inputTokens).toBe(1000)
    expect(events[0]?.estimatedCostUsd).toBe(5)
  })

  it('keeps the legacy totals when the migration recomputed session_v2 lower', () => {
    const path = createFixture({
      generation: 'migrated',
      // Upstream recomputes v2 totals from decoded messages; undecodable ones
      // are dropped, landing the v2 row below its frozen legacy copy.
      legacySessions: [{ id: 'ses_shared', directory: WORKTREE, tokensInput: 900 }],
      v2Sessions: [{ id: 'ses_shared', directory: WORKTREE, tokensInput: 120 }]
    })

    const events = readEvents(path)
    expect(events.map((event) => event.sessionId)).toEqual(['ses_shared'])
    expect(events[0]?.inputTokens).toBe(900)
  })

  it('resolves an identical migrated copy to session_v2', () => {
    const shared = { id: 'ses_shared', directory: WORKTREE, tokensInput: 64 }
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [{ ...shared, model: '{"providerID":"anthropic","modelID":"legacy"}' }],
      v2Sessions: [{ ...shared, model: '{"providerID":"anthropic","modelID":"v2"}' }]
    })

    const events = readEvents(path)
    expect(events.map((event) => event.sessionId)).toEqual(['ses_shared'])
    expect(events[0]?.inputTokens).toBe(64)
    // Equal totals: the tie goes to the newer table, so its row supplies metadata.
    expect(events[0]?.model).toContain('v2')
  })

  it('keeps legacy sessions that never migrated', () => {
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [{ id: 'ses_legacy_only', directory: WORKTREE, tokensInput: 42 }],
      v2Sessions: [{ id: 'ses_v2_1', directory: WORKTREE, tokensInput: 9 }]
    })

    expect(
      readEvents(path)
        .map((event) => event.sessionId)
        .sort()
    ).toEqual(['ses_legacy_only', 'ses_v2_1'])
  })

  it('still reads an OpenCode 1 database unchanged', () => {
    const path = createFixture({
      generation: 'v1',
      legacySessions: [
        {
          id: 'ses_v1',
          directory: WORKTREE,
          cost: 1.25,
          tokensInput: 11,
          tokensOutput: 3,
          tokensCacheRead: 7,
          tokensCacheWrite: 2
        }
      ]
    })

    expect(readEvents(path)).toEqual([
      expect.objectContaining({
        sessionId: 'ses_v1',
        estimatedCostUsd: 1.25,
        inputTokens: 11,
        outputTokens: 3,
        cachedInputTokens: 7,
        totalTokens: 23
      })
    ])
  })

  it('reads assistant session_message rows when session_v2 carries no totals', () => {
    const path = createFixture({
      generation: 'v2-only',
      v2Sessions: [{ id: 'ses_msg', directory: WORKTREE }]
    })
    const db = new Database(path)
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES ('msg-1', 'ses_msg', 'assistant', 1, ?, ?, ?)`
    ).run(
      OPENCODE_USAGE_FIXTURE_EPOCH_MS,
      OPENCODE_USAGE_FIXTURE_EPOCH_MS,
      JSON.stringify({
        tokens: { input: 60, output: 4, reasoning: 0, cache: { read: 12, write: 3 } },
        cost: 0.02,
        time: { created: OPENCODE_USAGE_FIXTURE_EPOCH_MS }
      })
    )
    db.close()

    expect(readEvents(path)).toEqual([
      expect.objectContaining({ sessionId: 'ses_msg', inputTokens: 60, cachedInputTokens: 12 })
    ])
  })

  it('attributes session_v2 usage to the worktree that ran it', async () => {
    const path = createFixture({
      generation: 'v2-only',
      v2Sessions: [
        { id: 'ses_in_worktree', directory: WORKTREE, tokensInput: 30 },
        { id: 'ses_elsewhere', directory: '/elsewhere/project', tokensInput: 40 }
      ]
    })

    const parsed = await parseOpenCodeUsageDatabase(path, await worktreeResolver())
    const byId = new Map(parsed.sessions.map((session) => [session.sessionId, session]))
    expect(byId.get('ses_in_worktree')).toMatchObject({
      primaryWorktreeId: 'repo-1::/workspace/repo',
      primaryRepoId: 'repo-1',
      primaryProjectLabel: 'Repo',
      totalInputTokens: 30
    })
    expect(byId.get('ses_elsewhere')).toMatchObject({
      primaryWorktreeId: null,
      primaryRepoId: null,
      totalInputTokens: 40
    })
  })

  it('keeps a session that only session_v2 has when a legacy twin is absent', () => {
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [{ id: 'ses_shared', directory: WORKTREE, tokensInput: 5 }],
      v2Sessions: [
        { id: 'ses_shared', directory: WORKTREE, tokensInput: 5 },
        { id: 'ses_v2_only', directory: WORKTREE, cost: 3.25, tokensInput: 70 }
      ]
    })

    const events = readEvents(path)
    const v2Only = events.find((event) => event.sessionId === 'ses_v2_only')
    expect(v2Only).toMatchObject({ inputTokens: 70, estimatedCostUsd: 3.25, cwd: WORKTREE })
  })

  it('falls back to the project worktree when the session has no directory', async () => {
    const path = createFixture({
      generation: 'v2-only',
      worktree: WORKTREE,
      v2Sessions: [{ id: 'ses_no_dir', directory: '', tokensInput: 15 }]
    })

    const parsed = await parseOpenCodeUsageDatabase(path, await worktreeResolver())
    expect(parsed.sessions[0]).toMatchObject({
      sessionId: 'ses_no_dir',
      primaryWorktreeId: 'repo-1::/workspace/repo'
    })
  })
})

// Why: a migrated session has two rows for one session, and neither is complete.
// `session_v2` is the row OpenCode still writes, so it says what the session is;
// each usage column is a lossy re-derivation, so each column takes the larger of
// the two. Ranking whole rows by one number let that number decide cost,
// directory and model too.
describe('OpenCode 2 migrated session column merge', () => {
  const SHARED = 'ses_shared'

  it('keeps a recorded cost the recomputed session_v2 row lost', () => {
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [{ id: SHARED, directory: WORKTREE, tokensInput: 100, cost: 12.5 }],
      v2Sessions: [{ id: SHARED, directory: WORKTREE, tokensInput: 200, cost: 0 }]
    })

    const events = readEvents(path)
    expect(events).toHaveLength(1)
    expect(events[0]?.inputTokens).toBe(200)
    expect(events[0]?.estimatedCostUsd).toBe(12.5)
  })

  it('attributes usage to the directory session_v2 records now', () => {
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [
        { id: SHARED, directory: '/old/pre-migration-path', title: 'Old title', tokensInput: 900 }
      ],
      v2Sessions: [
        { id: SHARED, directory: '/new/current-path', title: 'New title', tokensInput: 120 }
      ]
    })

    const events = readEvents(path)
    expect(events).toHaveLength(1)
    // The legacy row still wins the token column; it must not drag metadata with it.
    expect(events[0]?.inputTokens).toBe(900)
    expect(events[0]?.cwd).toBe('/new/current-path')
  })

  it('keeps the model session_v2 derived when the legacy row has none', () => {
    const path = createFixture({
      generation: 'migrated',
      // The import fills session_v2.model from the last user message when the v1
      // row had none: 23 of 234 shared ids on a real migrated database.
      legacySessions: [{ id: SHARED, directory: WORKTREE, model: null, tokensInput: 900 }],
      v2Sessions: [
        {
          id: SHARED,
          directory: WORKTREE,
          model: '{"providerID":"anthropic","modelID":"claude-opus-4-1"}',
          tokensInput: 120
        }
      ]
    })

    const events = readEvents(path)
    expect(events).toHaveLength(1)
    expect(events[0]?.inputTokens).toBe(900)
    expect(events[0]?.model).toBe('anthropic/claude-opus-4-1')
  })

  it('takes each usage column from whichever generation recorded more', () => {
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [
        { id: SHARED, directory: WORKTREE, tokensInput: 1000, tokensCacheRead: 0, cost: 1 }
      ],
      v2Sessions: [
        { id: SHARED, directory: WORKTREE, tokensInput: 0, tokensCacheRead: 1200, cost: 2 }
      ]
    })

    const events = readEvents(path)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 1200,
      estimatedCostUsd: 2,
      totalTokens: 2200
    })
  })

  it('resolves a faithful migrated copy exactly as the v2 row alone', () => {
    const session = {
      id: SHARED,
      directory: WORKTREE,
      cost: 0.75,
      tokensInput: 100,
      tokensOutput: 20,
      tokensReasoning: 5,
      tokensCacheRead: 900,
      tokensCacheWrite: 300
    }
    const migrated = readEvents(
      createFixture({
        generation: 'migrated',
        legacySessions: [session],
        v2Sessions: [session]
      })
    )

    expect(migrated).toEqual(
      readEvents(createFixture({ generation: 'v2-only', v2Sessions: [session] }))
    )
  })

  it('leaves an OpenCode 1-only database untouched by the merge', () => {
    const path = createFixture({
      generation: 'v1',
      legacySessions: [
        {
          id: 'ses_v1',
          directory: WORKTREE,
          cost: 1.25,
          tokensInput: 11,
          tokensOutput: 3,
          tokensCacheRead: 7,
          tokensCacheWrite: 2
        }
      ]
    })

    expect(readEvents(path)).toEqual([
      expect.objectContaining({
        sessionId: 'ses_v1',
        cwd: WORKTREE,
        model: 'anthropic/claude-sonnet-4-5',
        estimatedCostUsd: 1.25,
        inputTokens: 11,
        outputTokens: 3,
        cachedInputTokens: 7,
        totalTokens: 23
      })
    ])
  })

  it('emits exactly one row per session id across both generations', () => {
    const path = createFixture({
      generation: 'migrated',
      legacySessions: [
        { id: SHARED, directory: WORKTREE, tokensInput: 900 },
        { id: 'ses_legacy_only', directory: WORKTREE, tokensInput: 42 }
      ],
      v2Sessions: [
        { id: SHARED, directory: WORKTREE, tokensInput: 120 },
        { id: 'ses_v2_only', directory: WORKTREE, tokensInput: 7 }
      ]
    })

    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const ids = selectUsageRows(db).map((row) => row.id)
      expect(ids).toHaveLength(3)
      expect(new Set(ids).size).toBe(3)
    } finally {
      db.close()
    }
  })
})
