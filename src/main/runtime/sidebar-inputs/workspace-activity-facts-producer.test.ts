import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarClock } from './sidebar-clock'
import { AgentHookServer } from '../../agent-hooks/server'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import {
  WorkspaceActivityFactsProducer,
  type WorkspaceSurfaceActivity
} from './workspace-activity-facts-producer'

const WT_A = 'repo-1::/tmp/a'
const WT_B = 'repo-1::/tmp/b'
const FOLDER = 'folder:11111111-1111-4111-8111-111111111111'
const PANE_A = 'tab-a:11111111-1111-4111-8111-111111111111'
const PANE_B = 'tab-b:22222222-2222-4222-8222-222222222222'
const NONE: WorkspaceSurfaceActivity = { terminal: null, browser: false, structuredChat: false }

function createProducer(tabs: Record<string, string> = {}) {
  const surfaces = new Map<string, WorkspaceSurfaceActivity>()
  const readSurfaces = vi.fn((worktreeId: string) => surfaces.get(worktreeId) ?? NONE)
  const producer = new WorkspaceActivityFactsProducer({
    readSurfaces,
    resolveTabWorktreeId: (tabId) => tabs[tabId],
    clock: new SidebarClock()
  })
  return { producer, surfaces, readSurfaces }
}

function terminalStatus(
  server: AgentHookServer,
  paneKey: string,
  worktreeId: string,
  state: 'working' | 'waiting' | 'done',
  workingMode?: 'monitoring'
): void {
  server.ingestTerminalStatus({
    paneKey,
    tabId: paneKey.slice(0, paneKey.indexOf(':')),
    worktreeId,
    payload: {
      state,
      prompt: 'task',
      agentType: 'codex',
      ...(workingMode ? { workingMode } : {})
    }
  })
}

describe('WorkspaceActivityFactsProducer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists only active workspaces and bumps the revision only on a change', () => {
    const { producer, surfaces } = createProducer()
    surfaces.set(WT_A, { ...NONE, terminal: 'live' })
    surfaces.set(FOLDER, { ...NONE, browser: true, structuredChat: true })
    producer.refreshWorkspace(WT_A)
    producer.refreshWorkspace(FOLDER)
    producer.refreshWorkspace(WT_B)
    expect(producer.snapshot()).toEqual({
      revision: 2,
      facts: {
        [WT_A]: { terminal: 'live', browser: false, structuredChat: false, agent: null },
        [FOLDER]: { terminal: null, browser: true, structuredChat: true, agent: null }
      }
    })

    producer.refreshWorkspace(WT_A)
    expect(producer.snapshot().revision).toBe(2)

    surfaces.delete(WT_A)
    producer.refreshWorkspace(WT_A)
    expect(producer.snapshot()).toEqual({
      revision: 3,
      facts: { [FOLDER]: expect.anything() }
    })
  })

  it('keeps an SSH workspace whose host lost contact as unverifiable, not idle', () => {
    const { producer, surfaces } = createProducer()
    surfaces.set(WT_A, { ...NONE, terminal: 'live' })
    producer.refreshWorkspace(WT_A)
    surfaces.set(WT_A, { ...NONE, terminal: 'unverifiable' })
    producer.refreshWorkspace(WT_A)
    expect(producer.snapshot().facts[WT_A]?.terminal).toBe('unverifiable')
  })

  it('follows agent status transitions without re-reading any surfaces', () => {
    const server = new AgentHookServer()
    const { producer, readSurfaces } = createProducer()
    const detach = producer.attachAgentStatusStore(server)
    try {
      terminalStatus(server, PANE_B, WT_B, 'working')

      terminalStatus(server, PANE_A, WT_A, 'working')
      expect(producer.snapshot().facts[WT_A]?.agent).toBe('working')

      terminalStatus(server, PANE_A, WT_A, 'waiting')
      expect(producer.snapshot().facts[WT_A]?.agent).toBe('permission')

      terminalStatus(server, PANE_A, WT_A, 'working', 'monitoring')
      expect(producer.snapshot().facts[WT_A]?.agent).toBe('monitoring')

      terminalStatus(server, PANE_A, WT_A, 'done')
      expect(producer.snapshot().facts[WT_A]).toBeUndefined()
      expect(producer.snapshot().facts[WT_B]?.agent).toBe('working')
      expect(readSurfaces).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('keeps the surfaces it last read when only the agent changes', () => {
    const server = new AgentHookServer()
    const { producer, surfaces } = createProducer()
    surfaces.set(WT_A, { ...NONE, terminal: 'live' })
    producer.refreshWorkspace(WT_A)
    const detach = producer.attachAgentStatusStore(server)
    try {
      terminalStatus(server, PANE_A, WT_A, 'working')
      terminalStatus(server, PANE_A, WT_A, 'done')
      expect(producer.snapshot().facts[WT_A]).toEqual({
        terminal: 'live',
        browser: false,
        structuredChat: false,
        agent: null
      })
    } finally {
      detach()
    }
  })

  it('seeds from rows that predate attaching and attributes a pane through its tab', () => {
    const server = new AgentHookServer()
    terminalStatus(server, PANE_A, WT_B, 'working')
    const { producer } = createProducer({ 'tab-a': WT_A })
    const detach = producer.attachAgentStatusStore(server)
    try {
      expect(Object.keys(producer.snapshot().facts)).toEqual([WT_A])
    } finally {
      detach()
    }
  })

  it('re-attributes a pane once its tab becomes known', () => {
    const server = new AgentHookServer()
    const tabs: Record<string, string> = {}
    const { producer } = createProducer(tabs)
    const detach = producer.attachAgentStatusStore(server)
    try {
      server.ingestTerminalStatus({
        paneKey: PANE_A,
        tabId: 'tab-a',
        payload: { state: 'working', prompt: 'task', agentType: 'codex' }
      })
      expect(producer.snapshot().facts).toEqual({})
      tabs['tab-a'] = WT_A
      producer.resyncAgentPanes()
      expect(producer.snapshot().facts[WT_A]?.agent).toBe('working')
    } finally {
      detach()
    }
  })

  it('attributes an SSH pane to the workspace its host reported', () => {
    const server = new AgentHookServer()
    const { producer } = createProducer({ 'tab-a': WT_B })
    const detach = producer.attachAgentStatusStore(server)
    try {
      server.ingestRemote(
        {
          paneKey: PANE_A,
          tabId: 'tab-a',
          worktreeId: WT_A,
          payload: { state: 'working', prompt: 'remote', agentType: 'claude' }
        },
        'ssh-conn'
      )
      expect(producer.snapshot().facts[WT_A]?.agent).toBe('working')
      expect(producer.snapshot().facts[WT_B]).toBeUndefined()
    } finally {
      detach()
    }
  })

  it('drops an agent whose evidence goes stale, on one timer', () => {
    vi.useFakeTimers()
    const server = new AgentHookServer()
    const { producer } = createProducer()
    const detach = producer.attachAgentStatusStore(server)
    try {
      terminalStatus(server, PANE_A, WT_A, 'working')
      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS - 1)
      expect(producer.snapshot().facts[WT_A]?.agent).toBe('working')
      vi.advanceTimersByTime(2)
      expect(producer.snapshot().facts[WT_A]).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      detach()
    }
  })
})
