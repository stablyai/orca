// Runs on plain Node, as orcad does: a server with no window pushes its phones from its own hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'

// Switched on, as it ships next: that build's host reads hookless agents' titles itself.
vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

import {
  createHost,
  WT,
  PANE,
  terminalHostCleanups as cleanups
} from './terminal-phone-flow.test-fixture'

describe('terminal agent phone push on a headless host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 })
  })
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    vi.useRealTimers()
  })

  it('publishes distinct identified host ends in one done segment, but not restatements or cancellation', () => {
    const { server, alerts } = createHost()
    const end = (at: number, sessionBoundary?: true, interrupted?: true) =>
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: WT,
          source: 'codex',
          turnEndedAt: at,
          turnEndDisposition: 'identified',
          payload: { state: 'done', prompt: '', agentType: 'codex', sessionBoundary, interrupted }
        },
        'remote-fixture'
      )
    end(100, true)
    expect(alerts).toHaveLength(0)
    end(200)
    expect(alerts).toHaveLength(1)
    const segment = server.getStatusSnapshot()[0]?.stateStartedAt
    vi.advanceTimersByTime(6_000)
    end(300)
    expect(server.getStatusSnapshot()[0]?.stateStartedAt).toBe(segment)
    expect(
      alerts.filter((event) => event.type === 'notification').map((event) => event.notificationId)
    ).toEqual([expect.stringMatching(/:200$/), expect.stringMatching(/:300$/)])
    vi.advanceTimersByTime(6_000)
    end(300)
    expect(alerts).toHaveLength(2)
    end(400, undefined, true)
    expect(alerts).toHaveLength(2)
  })

  it('pushes a finish once it stays finished, a request for input at once, and never a prompt', () => {
    const { runtime, server, report, agentAlerts, alerts } = createHost()
    const ingest = (state: 'working' | 'done', agentType: string, isReplay = false) =>
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: WT,
          isReplay,
          payload: { state, prompt: '', agentType }
        },
        'runtime-output-control'
      )
    ingest('working', 'make')
    ingest('done', 'make')
    expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts).toEqual([])
    server.clearPaneState(PANE)
    ingest('done', 'claude', true)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'done',
      isReplay: true
    })
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts).toEqual([])
    cleanups.pop()!()
    server.clearPaneState(PANE)
    ingest('done', 'claude')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.isReplay).toBeUndefined()
    cleanups.push(runtime.attachAgentStatusStore(server))
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts).toEqual([])
    server.clearPaneState(PANE)
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

  // The detector holds one phase per pane, so the title's turn is the one the hook row finishes.
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

  it('keeps replacement ownership through title history, completion, announcement and departure', () => {
    const { runtime, server, alerts, addWorkspace } = createHost()
    const otherWorktree = 'repo-1::/tmp/worktree-b'
    const titleOwner = addWorkspace(WT, 'local')
    const oldOwner = addWorkspace(WT, 'ssh:owner-a')
    const currentOwner = addWorkspace(WT, 'ssh:owner-b')
    const historicalOwner = addWorkspace(otherWorktree, 'ssh:owner-b')
    const ingest = (state: 'working' | 'done', connectionId: string, worktreeId = WT): void => {
      vi.advanceTimersByTime(1)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId,
          payload: { state, prompt: '', agentType: 'claude' }
        },
        connectionId
      )
    }
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
    expect(titleOwner.smartTier).toBe('working')
    ingest('done', 'owner-b', otherWorktree)
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts).toHaveLength(0)
    expect(runtime.announcements.take(PANE)).toEqual([])
    expect(titleOwner.smartTier).toBeUndefined()
    expect(historicalOwner.smartTier).toBeUndefined()
    server.clearPaneState(PANE)

    ingest('working', 'owner-a')
    expect(oldOwner.smartTier).toBe('working')
    ingest('working', 'owner-b')
    expect(oldOwner.smartTier).toBeUndefined()
    expect(currentOwner.smartTier).toBe('working')
    ingest('done', 'owner-b')
    const completedAt = Date.now()
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      connectionId: 'owner-b',
      state: 'done',
      stateStartedAt: completedAt
    })
    expect(currentOwner.smartTier).toBe('done')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS - 1)
    expect(alerts).toHaveLength(0)
    expect(runtime.announcements.take(PANE)).toEqual([])
    vi.advanceTimersByTime(1)
    const id = buildAgentNotificationId({
      worktreeId: WT,
      paneKey: PANE,
      stateStartedAt: completedAt
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      type: 'notification',
      agentState: 'done',
      worktreeId: WT,
      notificationId: id
    })
    expect(runtime.announcements.take(PANE).map((entry) => entry.id)).toEqual([id])

    vi.advanceTimersByTime(6_000)
    ingest('working', 'owner-b')
    ingest('done', 'owner-b')
    expect(currentOwner.smartTier).toBe('done')
    server.clearPaneState(PANE)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(currentOwner.smartTier).toBeUndefined()
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts).toHaveLength(1)
    expect(runtime.announcements.take(PANE)).toEqual([])
  })
})
