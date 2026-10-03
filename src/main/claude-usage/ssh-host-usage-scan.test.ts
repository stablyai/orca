import { describe, expect, it, vi } from 'vitest'
import {
  mergeClaudeUsageWithSshHosts,
  scanClaudeUsageOnSshHosts,
  type ClaudeUsageSshTransport
} from './ssh-host-usage-scan'
import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsageSession,
  ClaudeUsageSshHostSnapshot
} from './types'
import type { SshClaudeUsageScanParams } from './ssh-usage-relay-contract'

function session(
  sessionId: string,
  locationKey: string,
  lastTimestamp = '2026-09-01T11:00:00.000Z'
): ClaudeUsageSession {
  return {
    sessionId,
    firstTimestamp: '2026-09-01T10:00:00.000Z',
    lastTimestamp,
    model: 'claude-opus-5',
    lastCwd: '/home/dev/repo',
    lastGitBranch: null,
    primaryWorktreeId: null,
    primaryRepoId: null,
    turnCount: 1,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCacheWrite1hTokens: 0,
    locationBreakdown: [
      {
        locationKey,
        projectLabel: 'dev/repo',
        repoId: null,
        worktreeId: null,
        turnCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0
      }
    ]
  }
}

function daily(day: string, projectKey: string): ClaudeUsageDailyAggregate {
  return {
    day,
    model: 'claude-opus-5',
    projectKey,
    projectLabel: 'dev/repo',
    repoId: null,
    worktreeId: null,
    turnCount: 1,
    zeroCacheReadTurnCount: 0,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0
  }
}

function snapshot(scannedAt: number): ClaudeUsageSshHostSnapshot {
  return { scannedAt, sessions: [session('old', 'cwd:/old')], dailyAggregates: [] }
}

function transport(
  connected: string[],
  requestScan: ClaudeUsageSshTransport['requestScan']
): ClaudeUsageSshTransport {
  return { listConnectedTargetIds: () => connected, requestScan: vi.fn(requestScan) }
}

describe('scanClaudeUsageOnSshHosts', () => {
  it('collects every page and scopes every key to the host', async () => {
    const worktrees = [
      { repoId: 'r', worktreeId: 'r::/home/dev/repo', path: '/home/dev/repo', displayName: 'Repo' }
    ]
    const hostTransport = transport(['box'], async (_targetId, params) => {
      const index = params.page?.index ?? 0
      return {
        scanId: 'scan-1',
        pageIndex: index,
        pageCount: 2,
        sessions: [session(`s${index}`, index === 0 ? 'worktree:r::/home/dev/repo' : 'unscoped')],
        dailyAggregates: [daily(`2026-09-0${index + 1}`, 'cwd:/tmp/scratch')]
      }
    })

    const result = await scanClaudeUsageOnSshHosts({
      transport: hostTransport,
      worktreesByTarget: new Map([['box', worktrees]]),
      previous: {},
      now: () => 42
    })

    expect(vi.mocked(hostTransport.requestScan).mock.calls.map(([, params]) => params)).toEqual([
      { worktrees },
      { worktrees, page: { scanId: 'scan-1', index: 1 } }
    ] satisfies SshClaudeUsageScanParams[])
    expect(result.box.scannedAt).toBe(42)
    expect(result.box.sessions.map((row) => row.locationBreakdown[0].locationKey)).toEqual([
      'ssh:box|worktree:r::/home/dev/repo',
      'ssh:box|unscoped'
    ])
    expect(result.box.dailyAggregates.map((row) => row.projectKey)).toEqual([
      'ssh:box|cwd:/tmp/scratch',
      'ssh:box|cwd:/tmp/scratch'
    ])
  })

  it('keeps one project repo id on two hosts in separate rows', async () => {
    // A project's repo id is shared by its execution hosts, so the same checkout
    // path on two hosts produces the same worktree id.
    const worktreeKey = 'worktree:project-1::/home/dev/repo'
    const result = await scanClaudeUsageOnSshHosts({
      transport: transport(['box-a', 'box-b'], async () => ({
        scanId: 'scan-1',
        pageIndex: 0,
        pageCount: 1,
        sessions: [session('s', worktreeKey)],
        dailyAggregates: [daily('2026-09-01', worktreeKey)]
      })),
      worktreesByTarget: new Map(),
      previous: {}
    })

    expect(result['box-a'].dailyAggregates[0].projectKey).toBe(`ssh:box-a|${worktreeKey}`)
    expect(result['box-b'].dailyAggregates[0].projectKey).toBe(`ssh:box-b|${worktreeKey}`)
    expect(result['box-a'].sessions[0].locationBreakdown[0].locationKey).toBe(
      `ssh:box-a|${worktreeKey}`
    )
  })

  it('keeps the last snapshot of offline, failing, and too-old hosts', async () => {
    const onHostError = vi.fn()
    const result = await scanClaudeUsageOnSshHosts({
      transport: transport(['failing', 'old-relay'], async (targetId) => {
        if (targetId === 'failing') {
          throw new Error('SSH relay is not ready')
        }
        return null
      }),
      worktreesByTarget: new Map([['offline', []]]),
      previous: { offline: snapshot(1), failing: snapshot(2), 'old-relay': snapshot(3) },
      onHostError
    })

    expect(result).toEqual({
      offline: snapshot(1),
      failing: snapshot(2),
      'old-relay': snapshot(3)
    })
    expect(onHostError).toHaveBeenCalledWith('failing', expect.any(Error))
  })

  it('drops hosts that have neither repos nor a live session', async () => {
    const result = await scanClaudeUsageOnSshHosts({
      transport: transport([], async () => null),
      worktreesByTarget: new Map(),
      previous: { removed: snapshot(1) }
    })

    expect(result).toEqual({})
  })

  it('rejects a page from a different scan instead of mixing results', async () => {
    const onHostError = vi.fn()
    const result = await scanClaudeUsageOnSshHosts({
      transport: transport(['box'], async (_targetId, params) => ({
        scanId: params.page ? 'scan-2' : 'scan-1',
        pageIndex: params.page?.index ?? 0,
        pageCount: 2,
        sessions: [],
        dailyAggregates: []
      })),
      worktreesByTarget: new Map(),
      previous: { box: snapshot(7) },
      onHostError
    })

    expect(result).toEqual({ box: snapshot(7) })
    expect(onHostError).toHaveBeenCalledOnce()
  })
})

describe('mergeClaudeUsageWithSshHosts', () => {
  it('appends host rows and keeps daily rows in day order', () => {
    const local = {
      sessions: [session('local', 'cwd:/a')],
      dailyAggregates: [daily('2026-09-02', 'cwd:/a')]
    }
    const merged = mergeClaudeUsageWithSshHosts(local, {
      box: {
        scannedAt: 1,
        sessions: [session('remote', 'ssh:box|cwd:/a')],
        dailyAggregates: [daily('2026-09-01', 'ssh:box|cwd:/a')]
      }
    })

    expect(merged.sessions.map((row) => row.sessionId)).toEqual(['local', 'remote'])
    expect(merged.dailyAggregates.map((row) => [row.day, row.projectKey])).toEqual([
      ['2026-09-01', 'ssh:box|cwd:/a'],
      ['2026-09-02', 'cwd:/a']
    ])
  })

  it('keeps sessions newest-first so Recent Sessions sees host sessions', () => {
    const local = {
      sessions: [
        session('local-new', 'cwd:/a', '2026-09-03T00:00:00.000Z'),
        session('local-old', 'cwd:/a', '2026-09-01T00:00:00.000Z')
      ],
      dailyAggregates: []
    }
    const merged = mergeClaudeUsageWithSshHosts(local, {
      box: {
        scannedAt: 1,
        sessions: [
          session('remote-newest', 'ssh:box|cwd:/a', '2026-09-04T00:00:00.000Z'),
          session('remote-mid', 'ssh:box|cwd:/a', '2026-09-02T00:00:00.000Z')
        ],
        dailyAggregates: []
      }
    })

    expect(merged.sessions.map((row) => row.sessionId)).toEqual([
      'remote-newest',
      'local-new',
      'remote-mid',
      'local-old'
    ])
  })

  it('returns the local projection untouched when there are no hosts', () => {
    const local = { sessions: [], dailyAggregates: [] }

    expect(mergeClaudeUsageWithSshHosts(local, {})).toBe(local)
  })
})
