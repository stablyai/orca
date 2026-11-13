import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks =
    await import('../../../../../github/pull-requests/refresh/pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('../../../../../github/pull-requests/refresh/pr-refresh-renderer-port', () =>
  moduleMocks.rendererPortModuleMock(coordinatorMocks)
)
vi.mock('../../../../../github/client/lookup/pr-for-branch-outcome', () =>
  moduleMocks.clientModuleMock(coordinatorMocks)
)
vi.mock('../../../../../github/repositories/github-api-repository-remote-probe', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('../../../../../github/api/rate-limit', () =>
  moduleMocks.rateLimitModuleMock(coordinatorMocks)
)

import { makePR } from '../../../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type { RpcContext } from '../../../core'
import type { Repo } from '../../../../../../shared/repo-types'

// The coordinator test reset pins fake time here.
const START_AT = 1_000
const { getPRForBranchOutcomeMock } = coordinatorMocks

const identity = {
  sourceEpoch: 'runtime:env:rt:1',
  repoId: 'server-repo',
  repoPath: '/client/path/ignored',
  worktreeId: 'wt-1',
  branch: 'feature/test',
  currentHeadOid: 'h2',
  executionHostId: null,
  provider: 'github' as const,
  linkedPRNumber: null,
  fallbackPRNumber: 7,
  fallbackPRSource: 'hosted-review' as const,
  selectionRevision: '|||||'
}

async function methods() {
  const { GITHUB_PR_DETAIL_RECOVERY_METHODS } = await import('./github-pr-detail-recovery-methods')
  const byName = Object.fromEntries(GITHUB_PR_DETAIL_RECOVERY_METHODS.map((m) => [m.name, m]))
  const runtime = {
    resolvePRDetailRecoveryCandidate: async () => ({
      cacheKey: '/server/repo::feature/test',
      repoKind: 'git' as const,
      repoId: 'server-repo',
      repoPath: '/server/repo',
      branch: 'feature/test',
      worktreeId: 'wt-1',
      currentHeadOid: 'h2',
      fallbackPRNumber: 7,
      fallbackPRSource: 'hosted-review' as const,
      connectionId: null,
      executionHostId: null
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only runtime.resolvePRDetailRecoveryCandidate and the caller identity.
  const context = (clientId: string) => ({ runtime, clientId }) as unknown as RpcContext
  // oxlint-disable-next-line typescript/no-explicit-any -- each method's params differ; the schemas are tested elsewhere.
  const call = (name: string, params: unknown, clientId = 'phone-1'): Promise<any> => {
    const method = byName[name]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method's own schema parses the params first, as the dispatcher does.
    return method.handler(method.params.parse(params) as never, context(clientId))
  }
  return { call }
}

describe('github.prDetailRecovery runtime methods', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a headless ticket through the shared drainer with the server repo path', async () => {
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ number: 8 }),
      fetchedAt: START_AT
    })
    const { call } = await methods()
    const started = await call('github.prDetailRecovery.start', {
      clientEpoch: { scope: 'g1000.panel', counter: 1 },
      identity,
      cacheKey: 'client-cache-key'
    })
    await vi.advanceTimersByTimeAsync(0)
    const prepared = await call('github.prDetailRecovery.wait', {
      ticketId: started.ticketId,
      afterRevision: started.revision
    })
    expect(prepared.phase).toBe('preparing')
    expect(
      await call(
        'github.prDetailRecovery.wait',
        { ticketId: started.ticketId, afterRevision: 0 },
        'phone-2'
      )
    ).toBeNull()

    await call('github.prDetailRecovery.commit', {
      ticketId: started.ticketId,
      prepareToken: prepared.preparation.token,
      publicationGrantId: 'grant-1'
    })
    await vi.advanceTimersByTimeAsync(0)
    const settled = await call('github.prDetailRecovery.wait', {
      ticketId: started.ticketId,
      afterRevision: 0
    })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(getPRForBranchOutcomeMock.mock.calls[0][0]).toBe('/server/repo')
    expect(getPRForBranchOutcomeMock.mock.calls[0][4]).toBe(7)
    expect(settled.terminal).toMatchObject({ kind: 'settled', outcome: { pr: { number: 8 } } })
  })

  describe('hosted reads and recovery share one execution slot', () => {
    async function compose(hostedDistro: string | null, recoveryDistro: string | null) {
      const { RuntimeHostedReviewCommands } =
        await import('../../../../integrations/reviews/runtime-hosted-review-commands')
      const { GITHUB_PR_DETAIL_RECOVERY_METHODS } =
        await import('./github-pr-detail-recovery-methods')
      let distro: string | null = null
      const repo: Repo = {
        id: 'server-repo',
        path: '/server/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'git'
      }
      const commands = new RuntimeHostedReviewCommands({
        resolveRepo: async () => repo,
        resolveTarget: async () => ({ repo, repoPath: repo.path }),
        getExecutionOptions: () =>
          distro ? { localGitExecOptions: { wslDistro: distro } } : undefined,
        recordCreated: () => {}
      })
      const start = GITHUB_PR_DETAIL_RECOVERY_METHODS[0]
      const startRecovery = async () => {
        distro = recoveryDistro
        const runtime = {
          resolvePRDetailRecoveryCandidate: (params: never) =>
            commands.resolvePRDetailRecoveryCandidate(params)
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start handler reads only this runtime resolver and the caller identity.
        const context = { runtime, clientId: 'desktop-1' } as unknown as RpcContext
        // oxlint-disable-next-line typescript/no-explicit-any -- the start result is a recovery snapshot.
        const snapshot: any = await start.handler(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed by the method's own schema, as the dispatcher does.
          start.params.parse({
            clientEpoch: { scope: 'g1000.panel', counter: 1 },
            identity: { ...identity, repoId: 'server-repo' },
            cacheKey: 'client-cache-key'
          }) as never,
          context
        )
        return snapshot
      }
      const hostedRead = () => {
        distro = hostedDistro
        void commands.getRepoPRForBranch('id:server-repo', 'feature/test')
      }
      return { startRecovery, hostedRead }
    }

    it.each([
      ['WSL', 'Ubuntu', 'Ubuntu', 1],
      ['non-WSL control', null, null, 1],
      ['unrelated distro control', 'Debian', 'Ubuntu', 0]
    ] as const)(
      '%s: a held hosted read is a certified predecessor',
      async (_name, hosted, recovery, expected) => {
        getPRForBranchOutcomeMock.mockReturnValue(new Promise(() => {}))
        const { startRecovery, hostedRead } = await compose(hosted, recovery)
        hostedRead()
        await vi.advanceTimersByTimeAsync(0)
        const snapshot = await startRecovery()
        expect(snapshot.predecessors).toHaveLength(expected)
        expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      }
    )

    it.each([
      ['WSL', 'Ubuntu', 'Ubuntu', { kind: 'superseded' }],
      ['non-WSL control', null, null, { kind: 'superseded' }],
      ['unrelated distro control', 'Debian', 'Ubuntu', undefined]
    ] as const)(
      '%s: a later hosted read supersedes the unadmitted ticket',
      async (_name, hosted, recovery, terminal) => {
        getPRForBranchOutcomeMock.mockReturnValue(new Promise(() => {}))
        const { startRecovery, hostedRead } = await compose(hosted, recovery)
        const snapshot = await startRecovery()
        hostedRead()
        const { waitPRDetailRecovery } =
          await import('../../../../../github/pull-requests/refresh/pr-detail-recovery-coordinator')
        const after = await waitPRDetailRecovery('rpc:desktop-1', snapshot.ticketId, -1)
        expect(after?.terminal).toEqual(terminal)
      }
    )
  })
})
