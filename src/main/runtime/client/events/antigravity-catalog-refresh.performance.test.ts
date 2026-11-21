import { afterEach, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'
import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'

afterEach(() => vi.useRealTimers())

it.each([750, 7500])(
  'does not wake a whole-catalog refresh for child-only activity among %s worktrees',
  async (worktrees) => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))
    const server = new AgentHookServer()
    const connectionId = 'ssh-fleet'
    server.beginRemoteRelaySession(connectionId)
    const detach = runtime.attachAgentStatusStore(server)
    let notices = 0
    const stop = runtime.onClientEvent((event) => {
      if (event.type === 'worktreeRowsChanged') {
        notices++
      }
    })
    const paneKey = (index: number) => `tab-${index}:00000000-0000-4000-8000-000000000000`
    const startedAt = Date.now()
    const report = (index: number, toolInput?: string) => {
      const state = toolInput === undefined ? 'done' : 'working'
      const payload: ParsedAgentStatusPayload = {
        agentType: 'antigravity',
        state,
        prompt: 'task',
        mainAgent: { state, stateStartedAt: state === 'done' ? Date.now() : startedAt },
        subagents:
          toolInput === undefined
            ? undefined
            : [{ id: 'child', state: 'working', startedAt, toolName: 'view_file', toolInput }]
      }
      server.ingestRemote(
        {
          source: 'antigravity',
          paneKey: paneKey(index),
          tabId: `tab-${index}`,
          worktreeId: `repo::/fleet/${index}`,
          providerSession: { key: 'conversation_id', id: `root-${index}` },
          payload
        },
        connectionId
      )
    }
    try {
      for (let index = 0; index < worktrees; index++) {
        report(index, 'first.ts')
      }
      await vi.advanceTimersByTimeAsync(2000)
      expect(server.getStatusSnapshot()).toHaveLength(worktrees)
      expect(notices).toBe(1)
      notices = 0
      for (let step = 0; step < 10; step++) {
        report(0, `file-${step}.ts`)
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect(notices).toBe(0)
      // A backstop read still sees the latest child, and parent changes keep their fast notice.
      const snapshot = () => server.getStatusSnapshotForPane(paneKey(0))[0]
      expect(snapshot()?.subagents?.[0]?.toolInput).toBe('file-9.ts')
      report(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(notices).toBe(1)
      expect(snapshot()?.state).toBe('done')
    } finally {
      stop()
      detach()
      server.stop()
    }
  }
)
