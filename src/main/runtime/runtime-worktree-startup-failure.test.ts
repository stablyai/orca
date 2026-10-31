import { afterEach, expect, it, vi } from 'vitest'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import { createWorkerWorktree } from './rpc/methods/orchestration/worker/worker-worktree-creation'
import { failFederatedAttachmentWithReceipt } from './rpc/methods/orchestration/federation/federation-start-receipt'
import { terminalExitError, terminalStartError } from '../../shared/terminal-start-failure'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'

const repo: Repo = {
  id: 'repo',
  path: '/folder',
  displayName: 'folder',
  badgeColor: 'blue',
  addedAt: 1
}
const worktree: Worktree = {
  id: 'worktree',
  repoId: repo.id,
  path: '/worktree',
  head: 'abc',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}
const cause = {
  kind: 'exited',
  exitCode: 256,
  initialOutputDiagnostic: 'git-bash-console-capacity'
} as const
const failures = [
  terminalStartError('agent_session_exited_during_start', cause, 'inc-failed'),
  terminalExitError('agent_session_exited_during_start', cause, 'inc-reused'),
  new Error('pty unavailable')
]
afterEach(() => vi.restoreAllMocks())

it.each(
  (['local', 'folder'] as const).flatMap((surface) =>
    (['startup', 'initial'] as const).flatMap((kind) =>
      failures.map((error, index) => ({ surface, kind, error, index }))
    )
  )
)(
  'preserves $surface $kind warning through consumers (failure $index)',
  async ({ surface, kind, error }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const createTerminal = vi.fn(async () => {
      throw error
    })
    const request = { repoSelector: repo.id, name: 'feature' }
    const startup =
      kind === 'startup'
        ? { startup: { command: 'codex' }, createdWithAgent: 'codex' as const }
        : {}
    const localArgs = {
      request,
      repo,
      worktree,
      ...startup,
      ports: {
        canSpawn: true,
        createTerminal,
        pasteDraft: vi.fn(),
        sendFollowup: vi.fn(),
        provision: vi.fn(async () => ({ setupSpawned: false, setupTerminalHandle: null })),
        activate: vi.fn()
      }
    }
    const folderArgs = {
      request,
      repo,
      ...startup,
      deps: {
        store: {
          getSettings: () => ({}),
          setWorktreeMeta: (_target: unknown, meta: unknown) => meta,
          getProjectHostSetups: () => []
        },
        ptySpawnAvailable: true,
        createTerminal,
        pasteDraft: vi.fn(),
        sendFollowup: vi.fn(),
        invalidateResolvedWorktrees: vi.fn(),
        notifyWorktreesChanged: vi.fn(),
        emitCreated: vi.fn(),
        activate: vi.fn()
      }
    }
    const result =
      surface === 'local'
        ? await startRuntimeLocalWorktreeTerminals(localArgs)
        : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: folder creation only uses the three supplied store methods; all terminal ports reject before a result is needed.
          await createRuntimeFolderWorktree(folderArgs as never)
    const path = surface === 'local' ? worktree.path : repo.path
    const explanation =
      error === failures[0]
        ? 'Git Bash reported its limit of 128 open terminals on this PC while starting the terminal. Close some Git Bash terminals and try again.'
        : error.message
    const warning = `Failed to create the ${kind} terminal for ${path}: ${explanation}`
    expect(result.warning).toBe(warning)
    expect(createTerminal).toHaveBeenCalledOnce()
    if (kind !== 'startup') {
      return
    }

    const workerArgs = {
      runtime: {
        createManagedWorktree: async () => ({ worktree, warning: result.warning }),
        listTerminals: vi.fn()
      },
      db: { recordWorkerStage: vi.fn() },
      dispatchId: 'dispatch',
      requestedWorktree: 'new-child',
      target: { repoSelector: repo.id, parentWorktreeId: 'parent' },
      params: { name: 'feature', from: 'term-coordinator' },
      agent: 'codex',
      withAgentTerminal: true,
      effects: []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker reaches only createManagedWorktree and recordWorkerStage before rejecting the actual warning for its missing startup handle.
    const workerError = await createWorkerWorktree(workerArgs as never).catch(
      (error: unknown) => error
    )
    expect(workerError).toEqual(new Error(warning))
    expect(workerArgs.runtime.listTerminals).not.toHaveBeenCalled()
    const receiptArgs = {
      db: {
        failRemoteAttachment: vi.fn(() => ({
          state: 'failed',
          stage: 'worktree_create',
          effects: '[]',
          residual_resources: '[]'
        }))
      },
      dispatchId: 'dispatch',
      runtimeEpoch: 'runtime',
      failedStage: 'worktree_create',
      error: workerError,
      setup: {},
      launch: {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: receipt construction only calls the supplied db method; setup/launch are forwarded unchanged.
    const receipt = failFederatedAttachmentWithReceipt(receiptArgs as never)
    expect(receipt).toMatchObject({ state: 'failed', stage: 'worktree_create', lastError: warning })
    expect(receiptArgs.db.failRemoteAttachment).toHaveBeenCalledWith(
      'dispatch',
      'worktree_create',
      warning,
      false
    )
  }
)
