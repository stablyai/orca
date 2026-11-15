import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks, handleMock, preparation } = await vi.hoisted(async () => {
  const moduleMocks =
    await import('../../github/pull-requests/refresh/pr-refresh-coordinator-test-mocks')
  const preparation: { held: Promise<void> | null; entered: boolean } = {
    held: null,
    entered: false
  }
  return {
    coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(),
    moduleMocks,
    handleMock: vi.fn(),
    preparation
  }
})

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../../github/pull-requests/refresh/pr-refresh-renderer-port', () =>
  moduleMocks.rendererPortModuleMock(coordinatorMocks)
)
vi.mock('../../github/client/lookup/pr-for-branch-outcome', () => {
  const client = moduleMocks.clientModuleMock(coordinatorMocks)
  return {
    ...client,
    preparePRBranchRead: async (...args: Parameters<typeof client.preparePRBranchRead>) => {
      const prepared = await client.preparePRBranchRead(...args)
      if (preparation.held) {
        preparation.entered = true
        await preparation.held
      }
      return prepared
    }
  }
})
vi.mock('../../github/repositories/github-api-repository-remote-probe', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('../../github/api/rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makePR } from '../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type { Repo } from '../../../shared/repository/repo-types'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const START_AT = 1_000
const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const sshRepo: Repo = { ...repo, connectionId: 'remote' }
let repos: Repo[] = [repo]
const store = {
  getRepo: (id: string) => repos.find((row) => row.id === id) ?? null,
  getRepos: () => repos,
  getProjects: () => [],
  getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
}
const sender = { id: 7, on: vi.fn(), once: vi.fn(), off: vi.fn(), removeListener: vi.fn() }

function startArgs(repoId: string, repoPath: string, executionHostId: string | null = 'local') {
  return {
    clientEpoch: { scope: 'g1000.panel', counter: 1 },
    cacheKey: '/repo::feature/test',
    identity: {
      sourceEpoch: 'renderer:a',
      repoId,
      repoPath,
      worktreeId: 'wt-1',
      branch: 'feature/test',
      currentHeadOid: 'h2',
      executionHostId,
      provider: 'github' as const,
      linkedPRNumber: null,
      fallbackPRNumber: 7,
      fallbackPRSource: 'hosted-review' as const,
      selectionRevision: '|||||'
    }
  }
}

function ticketIdOf(snapshot: unknown): string {
  if (typeof snapshot === 'object' && snapshot !== null && 'ticketId' in snapshot) {
    return String(snapshot.ticketId)
  }
  throw new Error('missing ticketId')
}

function prepareTokenOf(snapshot: unknown): string {
  const preparation =
    typeof snapshot === 'object' && snapshot !== null && 'preparation' in snapshot
      ? snapshot.preparation
      : null
  if (typeof preparation === 'object' && preparation !== null && 'token' in preparation) {
    return String(preparation.token)
  }
  throw new Error('missing preparation token')
}

async function register(): Promise<(channel: string, args: unknown) => Promise<unknown>> {
  const { registerGitHubPRDetailRecoveryHandlers } =
    await import('./github-pr-detail-recovery-handlers')
  const { setPRRefreshRegistrationCheck } =
    await import('../../github/pull-requests/refresh/pr-refresh-coordinator')
  const { isPRRefreshCandidateRegistered } = await import('./github-repo-routing')
  setPRRefreshRegistrationCheck((candidate) => isPRRefreshCandidateRegistered(candidate, repos))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo validation and routing read only getRepo(s), getProjects and getSettings.
  registerGitHubPRDetailRecoveryHandlers(store as never)
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>(
    handleMock.mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return async (channel, args) => handlers.get(channel)?.({ sender }, args)
}

beforeAll(async () => {
  await import('./github-pr-detail-recovery-handlers')
}, 600_000)

describe('native PR detail recovery handlers', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    handleMock.mockReset()
    repos = [repo]
    preparation.held = null
    preparation.entered = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses an unregistered repo and returns a registered local result through the drainer', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 8 }),
      fetchedAt: START_AT
    })
    const invoke = await register()
    expect(
      await invoke('gh:startPRDetailRecovery', startArgs('other', '/elsewhere'))
    ).toMatchObject({
      terminal: { kind: 'not-admitted', reason: 'validation' }
    })

    const started = await invoke('gh:startPRDetailRecovery', startArgs('repo-1', '/repo'))
    const ticketId = ticketIdOf(started)
    await vi.advanceTimersByTimeAsync(0)
    const prepared = await invoke('gh:waitPRDetailRecovery', { ticketId, afterRevision: 0 })
    await invoke('gh:commitPRDetailRecovery', {
      ticketId,
      prepareToken: prepareTokenOf(prepared),
      publicationGrantId: 'grant-1'
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(async () =>
      expect(await invoke('gh:waitPRDetailRecovery', { ticketId, afterRevision: 0 })).toMatchObject(
        {
          admitted: true,
          terminal: { kind: 'settled', outcome: { pr: { number: 8 } } }
        }
      )
    )
  })

  it.each([
    ['local', [sshRepo, repo], 'local', 11],
    ['legacy SSH', [repo, sshRepo], 'ssh:remote', 22],
    ['explicit-only SSH', [repo, { ...repo, executionHostId: 'ssh:remote' }], 'ssh:remote', 22],
    [
      'normalized SSH',
      [repo, { ...repo, executionHostId: 'ssh:remote%2Ftarget', connectionId: ' remote/target ' }],
      ' ssh:remote%2Ftarget ',
      22
    ]
  ] as const)(
    'returns the %s result beside a same-ID/path twin',
    async (_name, owners, host, number) => {
      repos = [...owners]
      getPRForBranchOutcomeMock.mockImplementation((_path, _branch, _linked, connectionId) =>
        Promise.resolve({
          kind: 'found',
          pr: makePR({
            number:
              connectionId === 'remote' || connectionId === 'remote/target'
                ? 22
                : connectionId
                  ? 33
                  : 11
          }),
          fetchedAt: START_AT
        })
      )
      const invoke = await register()
      const started = await invoke('gh:startPRDetailRecovery', startArgs(repo.id, repo.path, host))
      const ticketId = ticketIdOf(started)
      await vi.advanceTimersByTimeAsync(0)
      const prepared = await invoke('gh:waitPRDetailRecovery', { ticketId, afterRevision: 0 })
      await invoke('gh:commitPRDetailRecovery', {
        ticketId,
        prepareToken: prepareTokenOf(prepared),
        publicationGrantId: 'grant-1'
      })
      await vi.waitFor(async () =>
        expect(
          await invoke('gh:waitPRDetailRecovery', { ticketId, afterRevision: 0 })
        ).toMatchObject({
          admitted: true,
          terminal: { kind: 'settled', outcome: { pr: { number } } }
        })
      )
    }
  )

  it.each([
    ['conflicting SSH', 'ssh:remote', 'stale'],
    ['conflicting local', 'local', 'stale'],
    ['runtime', 'runtime:env', undefined],
    ['nested runtime SSH', 'runtime:env', 'nested'],
    ['unresolved owner', 'runtime:unresolved-owner', undefined]
  ] as const)('refuses an unbound %s owner', async (_name, executionHostId, connectionId) => {
    repos = [{ ...repo, executionHostId, connectionId }]
    const invoke = await register()
    expect(
      await invoke('gh:startPRDetailRecovery', startArgs(repo.id, repo.path, executionHostId))
    ).toMatchObject({
      admitted: false,
      terminal: { kind: 'not-admitted', reason: 'validation' }
    })
  })

  it('refuses recovery when the SSH owner disappears before main resolves it', async () => {
    repos = [repo, sshRepo]
    const args = startArgs(sshRepo.id, sshRepo.path, 'ssh:remote')
    const invoke = await register()
    repos = [repo]
    const refused = await invoke('gh:startPRDetailRecovery', args)
    expect(refused).toMatchObject({
      admitted: false,
      terminal: { kind: 'not-admitted', reason: 'validation' }
    })
  })

  it.each([null, 'invalid-host'])(
    'refuses recovery with missing or invalid owner host %s',
    async (host) => {
      const invoke = await register()
      expect(
        await invoke('gh:startPRDetailRecovery', startArgs(repo.id, repo.path, host))
      ).toMatchObject({
        admitted: false,
        terminal: { kind: 'not-admitted', reason: 'validation' }
      })
    }
  )

  it.each([
    ['disappears', [repo]],
    ['changes repository ID', [repo, { ...sshRepo, id: 'replacement' }]],
    [
      'changes account',
      [repo, { ...sshRepo, ghAccount: { host: 'github.com', user: 'other-account' } }]
    ]
  ] as const)(
    'refuses admission if the SSH owner %s during provider preparation',
    async (_name, changedRepos) => {
      repos = [repo, sshRepo]
      getPRForBranchOutcomeMock.mockResolvedValue({
        kind: 'found',
        pr: makePR({ number: 11 }),
        fetchedAt: START_AT
      })
      const invoke = await register()
      const started = await invoke(
        'gh:startPRDetailRecovery',
        startArgs(repo.id, repo.path, 'ssh:remote')
      )
      const ticketId = ticketIdOf(started)
      await vi.advanceTimersByTimeAsync(0)
      const prepared = await invoke('gh:waitPRDetailRecovery', { ticketId, afterRevision: 0 })
      const gate = Promise.withResolvers<void>()
      preparation.held = gate.promise
      try {
        await invoke('gh:commitPRDetailRecovery', {
          ticketId,
          prepareToken: prepareTokenOf(prepared),
          publicationGrantId: 'grant-1'
        })
        await vi.advanceTimersByTimeAsync(0)
        await vi.waitFor(() => expect(preparation.entered).toBe(true))
        repos = [...changedRepos]
        gate.resolve()
        await vi.waitFor(async () =>
          expect(
            await invoke('gh:waitPRDetailRecovery', { ticketId, afterRevision: 0 })
          ).toMatchObject({
            admitted: false,
            terminal: { kind: 'not-admitted', reason: 'unregistered' }
          })
        )
      } finally {
        gate.resolve()
      }
    }
  )
})
