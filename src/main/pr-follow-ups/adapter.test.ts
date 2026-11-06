import { afterEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { PRObservation } from '../github/pr-watch/pr-watch-types'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import type {
  FollowUpObservationSource,
  FollowUpHostInputs
} from '../../shared/pr-follow-ups/contracts'
import type { Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { getDefaultSettings } from '../../shared/constants'
import { installPrFollowUpAdapter } from './adapter'
import { installPrFollowUps } from './install'
import { launchFollowUp, prepareFollowUpLaunch } from './launch'

const reader = vi.hoisted(() => ({
  candidate: null as GitHubPRRefreshCandidate | null,
  observer: undefined as ((observation: PRObservation) => void) | undefined
}))
vi.mock('../github/pr-watch/pr-watch-seams', () => ({
  registerPRWatch: () => ({ unregister() {} }),
  subscribePRObservations: (observer: typeof reader.observer) => {
    reader.observer = observer
    return () => {
      reader.observer = undefined
    }
  },
  prFollowUpCandidate: () => reader.candidate,
  pullRequestActionsFor: () => [],
  ownerChatFor: () => null
}))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => null
}))
vi.mock('./launch', () => ({
  launchFollowUp: vi
    .fn()
    .mockResolvedValue({ status: 'accepted', identity: { surface: 'chat', sessionId: 'auto' } }),
  recoverFollowUpLaunch: vi.fn().mockResolvedValue({ status: 'unconfirmed' }),
  prepareFollowUpLaunch: vi.fn().mockImplementation(async ({ target }) => ({
    agent: 'codex',
    surface: 'chat',
    target: { kind: 'existing', worktree: `id:${target.worktreeId}` }
  }))
}))
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  vi.clearAllMocks()
  reader.candidate = null
})

it.each([true, false])(
  'admits the first discovery read with enabled at startup = %s',
  async (enabled) => {
    const db = new Database(':memory:')
    const global = {
      ...getDefaultSettings('/tmp/pr38950-adapter'),
      defaultTuiAgent: 'codex',
      prFollowUps: { enabled }
    }
    const repos = ['a', 'b'].map(
      (id) =>
        ({
          id,
          path: `/repo-${id}`,
          kind: 'git',
          upstream: { owner: 'owner', repo: id }
        }) as Repo
    )
    const rows = repos.map(
      (repo, index) =>
        ({
          id: `w${index}`,
          repoId: repo.id,
          instanceId: `i${index}`,
          branch: 'fix',
          linkedPR: null,
          isArchived: false,
          lastActivityAt: index
        }) as Worktree
    )
    const settingsListeners: ((updates: { prFollowUps?: { enabled: boolean } }) => void)[] = []
    const store = {
      getSettings: () => global,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => Object.fromEntries(rows.map((row) => [row.id, row])),
      onSettingsChanged: (listener: (typeof settingsListeners)[number]) => {
        settingsListeners.push(listener)
        return () => {}
      },
      onStateWritten: () => () => {}
    } as unknown as RuntimeStore
    let host: ReturnType<typeof installPrFollowUps> | undefined
    const runtime = {
      get prFollowUps() {
        return host?.engine
      },
      getOrchestrationDb: () => ({ db }),
      canPublishAgentLaunchTab: () => true,
      getAgentStatusSnapshotFn: () => [],
      subscribeStructuredAgentAvailability: () => () => {},
      agentTransitions: { subscribe: () => () => {} },
      onWorktreeLifecycle: () => () => {},
      onClientEvent: () => () => {},
      getRepoPRChecks: vi
        .fn()
        .mockResolvedValue([
          { name: 'unit', status: 'completed', conclusion: 'failure', url: null }
        ]),
      getRepoPRCheckDetails: vi.fn().mockResolvedValue(null),
      installPrFollowUpSource: (source: FollowUpObservationSource, inputs: FollowUpHostInputs) => {
        host = installPrFollowUps(
          runtime,
          store,
          source,
          inputs,
          () => () => {},
          () => {}
        )
        return () => host!.dispose()
      }
    } as unknown as OrcaRuntimeService
    let listed: readonly Worktree[] = []
    const release = installPrFollowUpAdapter(runtime, store, {
      worktrees: () => listed,
      load: async () => {
        listed = rows
      }
    })
    cleanup = async () => {
      await release()
      db.close()
    }
    await host!.engine.reconcile([])
    expect(launchFollowUp).not.toHaveBeenCalled()
    if (!enabled) {
      expect(host!.engine.target('w1')).toBeUndefined()
      global.prFollowUps.enabled = true
      for (const listener of settingsListeners) {
        listener({ prFollowUps: { enabled: true } })
      }
      await host!.engine.reconcile([])
    }
    const observation: PRObservation = {
      prKey: 'github.com/owner/b#42',
      state: 'open',
      headSha: 'head',
      headRefName: 'fix',
      baseSha: null,
      mergeable: 'UNKNOWN',
      checksFinal: true,
      failingCheckNames: [],
      readComplete: true,
      observedAt: Date.now()
    }
    reader.observer!(observation)
    await host!.engine.reconcile([])
    expect(host!.engine.forWorkspace('w1')).toBeNull()
    reader.candidate = {
      repoId: 'b',
      repoPath: '/repo-b',
      repoKind: 'git',
      branch: 'fix',
      cacheKey: 'resolved',
      linkedPRNumber: 42
    }
    reader.observer!(observation)
    await host!.engine.reconcile([])
    expect(host!.engine.forWorkspace('w1')?.view.state).toBe('armed')
    expect(host!.engine.forWorkspace('w0')).toBeNull()
    expect(launchFollowUp).not.toHaveBeenCalled()
    reader.observer!({
      ...observation,
      failingCheckNames: ['unit'],
      observedAt: observation.observedAt + 1
    })
    await host!.engine.reconcile([])
    expect(prepareFollowUpLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ baseSha: null }),
        target: expect.objectContaining({ worktreeId: 'w1' })
      })
    )
    expect(launchFollowUp).toHaveBeenCalledExactlyOnceWith(
      runtime,
      expect.objectContaining({ target: { kind: 'existing', worktree: 'id:w1' } })
    )
  }
)
