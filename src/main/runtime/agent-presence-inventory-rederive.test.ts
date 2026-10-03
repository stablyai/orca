import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { AgentPaneOwner } from '../../shared/agent-process-presence'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  InventoryLifecycleRuntime,
  PREDECESSOR,
  PTY,
  WORKTREE,
  processRow
} from './pty-inventory-lifecycle-fixture'

const TAB = '40000000-0000-4000-8000-000000000001'
const LEAF = '40000000-0000-4000-8000-000000000002'
const paneKey = makePaneKey(TAB, LEAF)
const owner = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const

describe('owners of terminals that survived a restart', () => {
  it('re-derives once when the runtime first meets a surviving terminal, never again', async () => {
    // A worktree not opened since restart: the persisted session binds its surviving terminal.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the three fields the persisted surface index reads.
    const session = {
      tabsByWorktree: { [WORKTREE]: [{ id: TAB }] },
      terminalLayoutsByTabId: { [TAB]: { ptyIdsByLeafId: { [LEAF]: PTY } } },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: PREDECESSOR }
    } as unknown as WorkspaceSessionState
    const publish = vi.fn()
    const owners = new Map<string, AgentPaneOwner>()
    const runtime = new InventoryLifecycleRuntime(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory sweep reads only the persisted session from the store.
      { getWorkspaceSession: () => session } as never,
      undefined,
      {
        onForegroundAgentPresence: publish,
        getAgentOwner: (key: string) => owners.get(key)
      }
    )
    const capture = vi.fn(async () => owner)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [processRow()],
      hasPty: () => true,
      captureAgentPresence: capture
    })
    await runtime.read()
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ paneKey }), owner)
    )
    await runtime.read()
    await Promise.resolve()
    expect(capture).toHaveBeenCalledTimes(1)
    runtime.setPtyController(null)
  })
})
