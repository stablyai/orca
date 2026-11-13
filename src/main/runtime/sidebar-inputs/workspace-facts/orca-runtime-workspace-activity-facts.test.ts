// Runs on plain Node, as orcad does: the producer and its runtime wiring import no Electron.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'
import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'
const LEAF = '22222222-2222-4222-8222-222222222222'

function createRuntime() {
  const runtime = new OrcaRuntimeService().sidebarFacts
  if (!runtime) {
    throw new Error('built without the sidebar facts layer')
  }
  return runtime
}

function snapshot(
  worktree: string,
  version: number,
  tabs: RuntimeMobileSessionTabsSnapshot['tabs']
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:test',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

const terminalTab = {
  type: 'terminal' as const,
  id: `tab-1::${LEAF}`,
  parentTabId: 'tab-1',
  leafId: LEAF,
  title: 'Terminal',
  ptyId: 'pty-1',
  isActive: true
}

describe('runtime workspace activity facts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads a terminal whose host lost contact as unverifiable, not live', () => {
    const runtime = createRuntime()
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: 'tab-1', worktreeId: WT, title: 'Terminal', activeLeafId: LEAF, layout: null }
      ],
      leaves: [{ tabId: 'tab-1', worktreeId: WT, leafId: LEAF, paneRuntimeId: 1, ptyId: 'pty-1' }],
      mobileSessionTabs: [snapshot(WT, 1, [terminalTab])]
    })
    vi.advanceTimersByTime(300)
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')

    runtime.markPtyLivenessUnverifiable('pty-1', 'relay dropped')
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('unverifiable')

    runtime.markPtyLivenessLive('pty-1')
    expect(runtime.getWorkspaceActivityFacts().facts[WT]?.terminal).toBe('live')
  })

  it('reads agent status from the hook-server store it is attached to', () => {
    const runtime = createRuntime()
    const server = new AgentHookServer()
    const detach = runtime.workspaceActivityFacts.attachAgentStatusStore(server)
    try {
      runtime.syncWindowGraph(1, {
        tabs: [
          { tabId: 'tab-1', worktreeId: WT, title: 'Terminal', activeLeafId: LEAF, layout: null }
        ],
        leaves: [],
        mobileSessionTabs: []
      })
      server.ingestTerminalStatus({
        paneKey: `tab-1:${LEAF}`,
        tabId: 'tab-1',
        payload: { state: 'waiting', prompt: 'approve?', agentType: 'claude' }
      })
      expect(runtime.getWorkspaceActivityFacts().facts[WT]?.agent).toBe('permission')
    } finally {
      detach()
    }
  })

  // Paired desktops can't read this host's feed, so the row notice stays on with it.
  it('still announces agent row changes and their capability', async () => {
    const runtime = new OrcaRuntimeService()
    const events: RuntimeClientEvent['type'][] = []
    const stop = runtime.onClientEvent((event) => events.push(event.type))
    const server = new AgentHookServer()
    const detach = runtime.attachAgentStatusStore(server)
    try {
      server.ingestTerminalStatus({
        paneKey: `tab-1:${LEAF}`,
        tabId: 'tab-1',
        payload: { state: 'working', agentType: 'claude' }
      })
      await vi.advanceTimersByTimeAsync(2000)
      expect(events).toContain('worktreeRowsChanged')
      expect(RUNTIME_CAPABILITIES).toContain('worktree.rows-changed-event.v1')
    } finally {
      detach()
      stop()
    }
  })
})
