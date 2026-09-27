import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeUsageDailyAggregate, ClaudeUsageSession } from './types'
import type { ClaudeUsageSshTransport } from './ssh-host-usage-scan'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn()
}))

import { ClaudeUsageStore, initClaudeUsagePath } from './store'
import { scanClaudeUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'

const remoteWorktreeId = 'repo-box::/home/dev/repo'

const remoteSession: ClaudeUsageSession = {
  sessionId: 'remote-session',
  firstTimestamp: '2026-09-26T10:00:00.000Z',
  lastTimestamp: '2026-09-26T10:05:00.000Z',
  model: 'claude-opus-5',
  lastCwd: '/home/dev/repo',
  lastGitBranch: 'main',
  primaryWorktreeId: remoteWorktreeId,
  primaryRepoId: 'repo-box',
  turnCount: 2,
  totalInputTokens: 300,
  totalOutputTokens: 40,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalCacheWrite1hTokens: 0,
  locationBreakdown: [
    {
      locationKey: `worktree:${remoteWorktreeId}`,
      projectLabel: 'Repo on box',
      repoId: 'repo-box',
      worktreeId: remoteWorktreeId,
      turnCount: 2,
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0
    }
  ]
}

const remoteDaily: ClaudeUsageDailyAggregate = {
  day: '2026-09-26',
  model: 'claude-opus-5',
  projectKey: `worktree:${remoteWorktreeId}`,
  projectLabel: 'Repo on box',
  repoId: 'repo-box',
  worktreeId: remoteWorktreeId,
  turnCount: 2,
  zeroCacheReadTurnCount: 0,
  inputTokens: 300,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0
}

function createBackingStore(): ConstructorParameters<typeof ClaudeUsageStore>[0] {
  return {
    getRepos: () => [
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the usage loader reads only these repo fields.
      {
        id: 'repo-box',
        path: '/home/dev/repo',
        displayName: 'Repo on box',
        connectionId: 'box'
      } as never
    ],
    getAllWorktreeMeta: () => ({})
  }
}

describe('ClaudeUsageStore SSH hosts', () => {
  let tempUserData: string

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'orca-claude-usage-ssh-'))
    getPathMock.mockReturnValue(tempUserData)
    initClaudeUsagePath()
    vi.mocked(scanClaudeUsageFilesViaWorker).mockReset()
    vi.mocked(scanClaudeUsageFilesViaWorker).mockResolvedValue({
      processedFiles: [],
      sessions: [],
      dailyAggregates: []
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempUserData, { recursive: true, force: true })
  })

  it('counts SSH host usage in the Orca scope and keeps it while the host is offline', async () => {
    let connected = ['box']
    const transport: ClaudeUsageSshTransport = {
      listConnectedTargetIds: () => connected,
      requestScan: vi.fn(async () => ({
        scanId: 'scan',
        pageIndex: 0,
        pageCount: 1,
        sessions: [remoteSession],
        dailyAggregates: [remoteDaily]
      }))
    }
    const store = new ClaudeUsageStore(createBackingStore(), { sshTransport: transport })
    await store.setEnabled(true)

    await store.refresh(true)
    connected = []
    await store.refresh(true)
    const summary = await store.getSummary('orca', '30d')

    expect(transport.requestScan).toHaveBeenCalledWith(
      'box',
      {
        worktrees: [
          {
            repoId: 'repo-box',
            worktreeId: remoteWorktreeId,
            path: '/home/dev/repo',
            displayName: 'Repo on box'
          }
        ]
      },
      {}
    )
    expect(transport.requestScan).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ sessions: 1, inputTokens: 300, topProject: 'Repo on box' })
    await store.flush()
    const persisted = JSON.parse(
      readFileSync(join(tempUserData, 'orca-claude-usage.json'), 'utf-8')
    )
    expect(Object.keys(persisted.sshHosts)).toEqual(['box'])
  })
})
