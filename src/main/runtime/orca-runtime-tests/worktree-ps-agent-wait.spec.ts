import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'
import { AgentHookServer, _internals } from '../../agent-hooks/server'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

async function makeRuntimeWithHookRow(
  state: 'waiting' | 'working',
  source: 'terminal' | 'http' = 'terminal'
) {
  const statusStore = new AgentHookServer()
  const runtime = new OrcaRuntimeService(store, undefined, {
    getAgentStatusSnapshot: () => statusStore.getStatusSnapshot()
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-ps-agent-wait' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command: 'claude'
  })
  const payload = { state, prompt: 'review the PR', agentType: 'claude' } as const
  if (source === 'http') {
    const paneKey = runtime.getTerminalPaneKey(handle)
    if (!paneKey) {
      throw new Error('expected the terminal to own a pane key')
    }
    // Hook posts carry only the pane key, so the row has no terminal handle to look up.
    statusStore.ingestRemote({ paneKey, worktreeId: TEST_WORKTREE_ID, payload }, null)
    expect(statusStore.getStatusSnapshot()[0]).not.toHaveProperty('terminalHandle')
    return runtime
  }
  statusStore.ingestTerminalStatus({
    paneKey: makePaneKey('tab-ps-wait', '22222222-2222-4222-8222-222222222222'),
    tabId: 'tab-ps-wait',
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    terminalHandle: handle,
    payload
  })
  return runtime
}

async function readAgentRow(runtime: OrcaRuntimeService, includeAgentWait: boolean) {
  const { worktrees } = await runtime.getWorktreePs(undefined, true, includeAgentWait)
  const agents = worktrees.find((entry) => entry.worktreeId === TEST_WORKTREE_ID)?.agents
  expect(agents).toHaveLength(1)
  return agents?.[0]
}

describe('worktree ps agentWait', () => {
  beforeEach(() => {
    _internals.resetCachesForTests()
  })

  it('reports the terminal hook wait only when requested', async () => {
    const runtime = await makeRuntimeWithHookRow('waiting')
    const probe = vi.spyOn(runtime, 'getTerminalInteractiveWait')

    expect(await readAgentRow(runtime, false)).not.toHaveProperty('agentWait')
    expect(probe).not.toHaveBeenCalled()
    expect((await readAgentRow(runtime, true))?.agentWait).toMatchObject({ source: 'hook' })
  })

  it('resolves the live terminal for a hook row that reported only its pane', async () => {
    const runtime = await makeRuntimeWithHookRow('waiting', 'http')

    expect((await readAgentRow(runtime, true))?.agentWait).toMatchObject({ source: 'hook' })
  })

  it('reports null when the terminal shows no wait', async () => {
    const runtime = await makeRuntimeWithHookRow('working')

    expect((await readAgentRow(runtime, true))?.agentWait).toBeNull()
  })
})
