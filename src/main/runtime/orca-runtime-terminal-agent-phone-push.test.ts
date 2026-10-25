// Exercise windowless phone pushes under Node, as orcad runs them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import {
  partialRuntimeStore,
  storeFolderWorkspace,
  storeProjectGroup,
  storeRepo,
  storeWorktreeMeta,
  type PartialRuntimeStore
} from './runtime-store-partial-fixture'

// Main-owned sidebar status reads hookless agent titles.
vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'
const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function createHost(windowId: number | null = HEADLESS_RUNTIME_WINDOW_ID) {
  const store: PartialRuntimeStore = {
    getRepos: () => [],
    getRepo: (id: string) =>
      id === 'repo-1'
        ? storeRepo({ id, path: '/repo-1', connectionId: null, displayName: 'orca' })
        : undefined,
    getSettings: () => ({ notifications: getDefaultNotificationSettings() }),
    getWorktreeMeta: (id: string) =>
      id === WT ? storeWorktreeMeta({ displayName: 'feature' }) : undefined,
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [
      storeFolderWorkspace({ id: 'f1', name: 'Notes', projectGroupId: 'g1', folderPath: '/notes' })
    ],
    getProjectGroups: () => [storeProjectGroup({ id: 'g1', name: 'Research' })]
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  if (windowId !== null) {
    runtime.syncWindowGraph(windowId, { tabs: [], leaves: [] })
  }
  const server = new AgentHookServer()
  runtime.attachAgentStatusStore(server)
  const alerts: MobileNotificationEvent[] = []
  runtime.onNotificationDispatched((event) => alerts.push(event))
  const report = (
    state: 'working' | 'done' | 'waiting',
    sessionBoundary?: true,
    worktreeId = WT
  ): void =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId,
      payload: { state, prompt: 'fix the bug', agentType: 'claude', sessionBoundary }
    })
  const agentAlerts = (): (string | undefined)[] =>
    alerts.flatMap((event) =>
      event.type === 'notification' && event.source === 'agent-task-complete'
        ? [event.agentState]
        : []
    )
  return { runtime, report, agentAlerts, alerts }
}

describe('terminal agent phone push on a headless host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes a finish once it stays finished, a request for input at once, and never a prompt', () => {
    const { report, agentAlerts, alerts } = createHost()
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    vi.advanceTimersByTime(5_000)
    report('working')
    report('waiting')
    expect(agentAlerts()).toEqual(['done', 'waiting'])
    expect(alerts[0]).toMatchObject({
      title: expect.stringContaining('Claude finished'),
      worktreeId: WT
    })
  })

  it('pushes nothing while a desktop window owns the host: the window pushes its phones itself', () => {
    const { report, agentAlerts } = createHost(1)
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    report('working')
    report('waiting')
    expect(agentAlerts()).toEqual([])
  })

  it('pushes nothing for a session boundary such as a clear or a compaction', () => {
    const { report, agentAlerts } = createHost()
    report('working')
    report('done', true)
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(agentAlerts()).toEqual([])
  })

  it('titles a folder workspace with its project group, as the window does', () => {
    const { report, alerts } = createHost()
    report('working', undefined, 'folder:f1')
    report('done', undefined, 'folder:f1')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts[0]).toMatchObject({ title: 'Research / Notes - Claude finished' })
  })

  it('stays silent on a desktop whose window has not shown yet: that window seeds what it missed', () => {
    const { report, agentAlerts } = createHost(null)
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(agentAlerts()).toEqual([])
  })

  it('pushes once the desktop’s window has closed', () => {
    const { runtime, report, agentAlerts } = createHost(1)
    runtime.markGraphUnavailable(1)
    report('working')
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(agentAlerts()).toEqual(['done'])
  })

  // One detector phase per pane lets a hook finish the title-started turn.
  it('pushes the finish of a turn a hookless title started and the first hook row ends', () => {
    const { runtime, report, agentAlerts } = createHost()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
      tabs: [{ tabId: 'tab-1', worktreeId: WT, title: 'Agent', activeLeafId: null, layout: null }],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: WT,
          leafId: PANE.slice('tab-1:'.length),
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', '\x1b]0;⠋ Codex working\x07', 1)
    report('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(agentAlerts()).toEqual(['done'])
  })
})
