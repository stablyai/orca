import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

import { makeCandidate } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const alice = { host: 'github.com', user: 'Alice' }
const bob = { host: 'github.com', user: 'Bob' }

describe('PR refresh account binding', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1_700_000_000_000 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the bound account when refreshing manually', async () => {
    const { refreshPRNow } = await import('./pr-refresh-coordinator')
    await refreshPRNow(makeCandidate({ localGitOptions: { ghAccount: alice } }))

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      '/repo',
      'feature/test',
      null,
      null,
      null,
      { localGitExecOptions: { ghAccount: alice, admissionTier: 'interactive' } }
    )
  })

  it.each([undefined, 42])(
    'keeps queued accounts separate for linked PR %s on the same branch',
    async (linkedPRNumber) => {
      const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
      for (const ghAccount of [alice, bob, undefined]) {
        enqueuePRRefresh(
          makeCandidate({ linkedPRNumber, localGitOptions: { ghAccount } }),
          'active',
          80,
          1
        )
      }
      await vi.runOnlyPendingTimersAsync()
      await vi.runOnlyPendingTimersAsync()
      await vi.runOnlyPendingTimersAsync()

      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
      expect(
        getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.localGitExecOptions?.ghAccount)
      ).toEqual(expect.arrayContaining([alice, bob, undefined]))
    }
  )

  it('coalesces normalized host and whitespace variants of one account', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    for (const ghAccount of [alice, { host: ' GitHub.COM ', user: ' Alice ' }]) {
      enqueuePRRefresh(makeCandidate({ localGitOptions: { ghAccount } }), 'active', 80, 1)
    }
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('keeps exact gh login selection and different hosts separate', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    const bindings = [
      alice,
      { host: 'github.com', user: 'alice' },
      { host: 'github.example.com', user: 'Alice' }
    ]
    for (const ghAccount of bindings) {
      enqueuePRRefresh(makeCandidate({ localGitOptions: { ghAccount } }), 'active', 80, 1)
    }
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    expect(
      getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.localGitExecOptions?.ghAccount)
    ).toEqual(expect.arrayContaining(bindings))
  })
})
