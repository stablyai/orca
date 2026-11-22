import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../construction/test-context/runtime-store-partial-fixture'

it.each([750, 7500])(
  'model metadata leaves the %s-workspace catalog idle while a state change refreshes it',
  async (count) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const repo = storeRepo({ id: 'repo', path: '/home/agent/wt-0', connectionId: 'ssh-agent' })
    const worktreeId = (index: number) => `repo::/home/agent/wt-${index}`
    const meta = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        worktreeId(index),
        storeWorktreeMeta({ instanceId: `worktree-${index}` })
      ])
    )
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [repo],
        getRepo: (id) => (id === repo.id ? repo : undefined),
        getAllWorktreeMeta: () => meta,
        getWorktreeMeta: (id) => meta[id]
      })
    )
    const listProcesses = vi.fn(async () => [])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const server = new AgentHookServer()
    const desktop = vi.fn()
    server.setListener(desktop)
    const detachRows = runtime.attachAgentStatusStore(server)
    const refreshes: ReturnType<typeof runtime.getWorktreePs>[] = []
    const detachClient = runtime.onClientEvent(
      (event) => {
        if (event.type === 'worktreeRowsChanged') {
          refreshes.push(runtime.getWorktreePs(10_000))
        }
      },
      { consumesTerminalSideEffects: false }
    )
    const row: AgentHookRelayEnvelope = {
      source: 'antigravity',
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      tabId: 'tab',
      worktreeId: worktreeId(0),
      connectionId: null,
      hookEventName: 'PreInvocation',
      providerSession: { key: 'conversation_id', id: 'root' },
      payload: { agentType: 'antigravity', state: 'working', prompt: 'Task' }
    }
    try {
      server.ingestRemote(row, 'ssh-agent')
      await vi.advanceTimersByTimeAsync(2000)
      expect(refreshes).toHaveLength(1)
      expect((await refreshes[0]!).worktrees).toHaveLength(count)
      refreshes.length = 0
      listProcesses.mockClear()
      desktop.mockClear()

      server.ingestRemote(
        {
          ...row,
          modelOnly: true,
          hookEventName: undefined,
          payload: { ...row.payload, model: 'resolved-model' }
        },
        'ssh-agent'
      )
      expect(server.getStatusSnapshotForPane(row.paneKey)[0]?.model).toBe('resolved-model')
      expect(desktop).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ payload: expect.objectContaining({ model: 'resolved-model' }) })
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(refreshes).toHaveLength(0)
      expect(listProcesses).not.toHaveBeenCalled()

      server.ingestRemote(
        {
          ...row,
          hookEventName: 'PreToolUse',
          payload: { ...row.payload, state: 'waiting', model: 'resolved-model' }
        },
        'ssh-agent'
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(server.getStatusSnapshotForPane(row.paneKey)[0]?.state).toBe('waiting')
      expect(refreshes).toHaveLength(1)
      expect((await refreshes[0]!).worktrees).toHaveLength(count)
      expect(listProcesses).toHaveBeenCalledTimes(1)
    } finally {
      detachClient()
      detachRows()
      server.stop()
      vi.useRealTimers()
    }
  }
)
