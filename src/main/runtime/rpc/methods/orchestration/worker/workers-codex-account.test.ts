import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationRpcState } from '../rpc-test-harness'
import { resolveCodexLaunchAccount } from '../../../../../codex-accounts/codex-launch-account'

const h = createOrchestrationRpcHarness()
let state: OrchestrationRpcState
const accounts = [
  { id: 'account-a', email: 'a@example.com' },
  { id: 'account-b', email: 'b@example.com' }
]

beforeEach(() => {
  state = h.setup()
  const { runtime } = state
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
