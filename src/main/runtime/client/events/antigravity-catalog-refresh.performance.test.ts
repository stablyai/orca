import { afterEach, expect, it, vi } from 'vitest'
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
    const detach = runtime.attachAgentStatusStore(server)
    let notices = 0
    const stop = runtime.onClientEvent((event) => {
      if (event.type === 'worktreeRowsChanged') {
        notices++
      }
    })
    const row = (index: number, toolInput: string) => ({
      paneKey: `tab-${index}:00000000-0000-4000-8000-000000000000`,
      tabId: `tab-${index}`,
      worktreeId: `repo::/fleet/${index}`,
      payload: {
        agentType: 'antigravity',
        state: 'working' as const,
        prompt: 'task',
        subagents: [{ id: 'child', state: 'working' as const, toolName: 'view_file', toolInput }]
      }
    })
    try {
      for (let index = 0; index < worktrees; index++) {
        server.ingestTerminalStatus(row(index, 'first.ts'))
      }
      await vi.advanceTimersByTimeAsync(2000)
      expect(notices).toBe(1)
      notices = 0
      for (let step = 0; step < 10; step++) {
        server.ingestTerminalStatus(row(0, `file-${step}.ts`))
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect(notices).toBe(0)
      // A backstop read still sees the latest child, and parent changes keep their fast notice.
      expect(
        server.getStatusSnapshotForPane(row(0, '').paneKey)[0]?.subagents?.[0]?.toolInput
      ).toBe('file-9.ts')
      const done = row(0, 'file-9.ts')
      server.ingestTerminalStatus({ ...done, payload: { ...done.payload, state: 'done' } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(notices).toBe(1)
    } finally {
      stop()
      detach()
      server.stop()
    }
  }
)
