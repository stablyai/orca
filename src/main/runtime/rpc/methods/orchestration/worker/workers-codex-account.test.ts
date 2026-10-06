import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationRpcState } from '../rpc-test-harness'
import { resolveCodexLaunchAccount } from '../../../../../codex-accounts/codex-launch-account'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { startRuntimeLocalWorktreeTerminals } from '../../../../runtime-local-worktree-terminal-startup'
import { WorktreeStartupError } from '../../../../../../shared/worktree/worktree-startup-error'

const h = createOrchestrationRpcHarness()
let state: OrchestrationRpcState
const accounts = [
  { id: 'account-a', email: 'a@example.com' },
  { id: 'account-b', email: 'b@example.com' }
]

beforeEach(() => {
  state = h.setup()
  const { runtime } = state
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git'
  })
  vi.spyOn(state.db, 'createStartingWorkerDispatch')
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_coord'
      ? h.coordinatorPaneKey
      : handle === 'term_worker'
        ? 'tab_worker:leaf_worker'
        : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker placement reads only id/repoId and the terminal handle/status from these fixtures.
    async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these worker paths read only workspace id and repoId.
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
    id: 'repo::worktree',
    repoId: 'repo'
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing-workspace worker placement reads only this workspace id.
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::worktree'
  } as never)
  vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_worker',
    worktreeId: 'repo::worktree',
    title: null
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'resolveAgentLaunchAccount').mockImplementation(async (args) => {
    if (args.account === undefined) {
      return undefined
    }
    return resolveCodexLaunchAccount(accounts, args.account)
  })
})
afterEach(() => h.cleanup())

function start(params: Record<string, unknown>) {
  return h.call(
    'orchestration.workerStart',
    { from: 'term_coord', spec: 'isolated fixture worker', agent: 'codex', ...params },
    state.ctx
  )
}

describe('worker-start account plumbing and durable receipts', () => {
  it.each(['new-child', 'new-top-level'] as const)(
    'preserves the created %s when pinned terminal startup fails',
    async (requestedWorktree) => {
      const { db, runtime } = state
      const createdWorktree: Worktree = {
        id: 'repo::created',
        repoId: 'repo',
        path: '/created',
        head: 'abc',
        branch: 'pinned-worker',
        isBare: false,
        isMainWorktree: false,
        displayName: 'pinned-worker',
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
      vi.spyOn(runtime, 'resolveAgentLaunchAccount').mockResolvedValue({
        provider: 'codex',
        requested: 'account-b',
        effective: { id: 'account-b', email: 'b@example.com' }
      })
      vi.mocked(runtime.createTerminal).mockRejectedValue(new Error('pinned auth unavailable'))
      const activate = vi.fn()
      const provision = vi.fn()
      vi.spyOn(runtime, 'removeManagedWorktree')
      vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (request) => {
        await startRuntimeLocalWorktreeTerminals({
          request: { ...request, startupCodexAccountId: 'account-b' },
          repo: { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
          worktree: createdWorktree,
          createdWithAgent: 'codex',
          startup: { command: 'codex' },
          ports: {
            canSpawn: true,
            createTerminal: (selector, options) => runtime.createTerminal(selector, options),
            pasteDraft: vi.fn(),
            sendFollowup: vi.fn(),
            provision,
            activate
          }
        })
        throw new Error('Pinned startup must reject before this point')
      })

      const result = await start({
        worktree: requestedWorktree,
        account: 'account-b',
        name: 'pinned-worker'
      })
      const effect = {
        kind: 'worktree',
        action: requestedWorktree === 'new-child' ? 'created_child' : 'created_top_level',
        id: createdWorktree.id
      }
      expect(result).toMatchObject({
        state: 'failed',
        failedStage: 'worktree_create',
        lastError: 'pinned auth unavailable',
        effects: [effect],
        residualResources: [effect],
        launch: { account: { effective: { id: 'account-b' } } }
      })
      if (
        !result ||
        typeof result !== 'object' ||
        !('dispatchId' in result) ||
        typeof result.dispatchId !== 'string'
      ) {
        throw new Error('Missing failed Dispatch receipt')
      }
      const worker = db.getWorkerDispatch(result.dispatchId)!
      expect(worker.worktree_id).toBe(createdWorktree.id)
      expect(JSON.parse(worker.effects)).toEqual([effect])
      expect(JSON.parse(worker.residual_resources)).toEqual([effect])
      expect(worker.agent_terminal_handle).toBeNull()
      expect(db.getWorkerTerminalResourceByOwner(result.dispatchId)).toBeUndefined()
      expect(db.listTasks()[0]?.status).toBe('failed')
      expect(result).not.toHaveProperty('recovery')
      expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        `id:${createdWorktree.id}`,
        expect.objectContaining({ codexAccountId: 'account-b' })
      )
      expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
      expect(provision).not.toHaveBeenCalled()
    }
  )

  it('preserves the known worktree while pinned terminal acceptance remains unknown', async () => {
    const { runtime } = state
    vi.spyOn(runtime, 'createManagedWorktree').mockRejectedValue(
      new WorktreeStartupError(
        'repo::created',
        Object.assign(new Error('terminal acceptance uncertain'), { code: 'operation_unknown' })
      )
    )
    const result = await start({
      worktree: 'new-child',
      name: 'pinned-worker',
      account: 'account-b'
    })
    expect(result).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'worktree_create',
      lastError: 'terminal acceptance uncertain',
      effects: [expect.objectContaining({ kind: 'worktree', id: 'repo::created' })],
      residualResources: [expect.objectContaining({ kind: 'worktree', id: 'repo::created' })]
    })
    expect(result).not.toHaveProperty('recovery')
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it.each(['account-b', 'B@EXAMPLE.COM', 'system'])(
    'pins %s through current-workspace launch and records its receipt',
    async (account) => {
      const receipt = resolveCodexLaunchAccount(accounts, account)
      const result = await start({ account })
      expect(result).toMatchObject({ state: 'ready', launch: { account: receipt } })
      expect(state.runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::worktree',
        expect.objectContaining({ startupAgent: 'codex', codexAccountId: receipt.effective.id })
      )
      if (
        !result ||
        typeof result !== 'object' ||
        !('dispatchId' in result) ||
        typeof result.dispatchId !== 'string'
      ) {
        throw new Error('missing dispatch receipt')
      }
      const dispatch = state.db.getWorkerDispatch(result.dispatchId)
      expect(JSON.parse(dispatch?.start_options ?? 'null')).toMatchObject({
        launch: { account: receipt }
      })
    }
  )

  it('omits the account argument and receipt for legacy launches', async () => {
    const result = await start({})
    expect(result).not.toHaveProperty('launch.account')
    expect(state.runtime.resolveAgentLaunchAccount).not.toHaveBeenCalled()
    expect(vi.mocked(state.runtime.createTerminal).mock.calls[0][1]).not.toHaveProperty(
      'codexAccountId'
    )
  })

  it.each([
    { agent: 'claude' },
    { terminal: 'term_existing' },
    { on: 'old-server' },
    { account: 'unknown' }
  ])(
    'refuses an unsupported request %j before any Task, Dispatch or terminal is created',
    async (params) => {
      await expect(start({ account: 'account-b', ...params })).rejects.toThrow()
      expect(state.db.listTasks()).toEqual([])
      expect(state.db.createStartingWorkerDispatch).not.toHaveBeenCalled()
      expect(state.runtime.createTerminal).not.toHaveBeenCalled()
      expect(state.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  )
})
