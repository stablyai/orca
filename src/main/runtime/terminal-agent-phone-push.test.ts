import { describe, expect, it } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  AGENT_DONE_QUIET_MS,
  type AgentTransition
} from '../../shared/agent-status/lifecycle/agent-transitions'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import type { MobileNotificationDispatchEvent } from './push/notifications/runtime-mobile-notification-controller'
import '../notifications/notification-delivery-service'
import { TerminalAgentPhonePush } from './terminal-agent-phone-push'

const WT = 'repo-1::/tmp/wt'
const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'done',
    prompt: 'fix the bug',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 5_000,
    lastAssistantMessage: 'Fixed it.',
    ...overrides
  }
}

function moved(
  transition: AgentTransition | null,
  to: 'done' | 'needs-you' | 'working' | 'rest' = 'done'
): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: WT, sshHostId: null },
    from: 'working',
    to,
    at: 1,
    transition
  }
}

function harness(
  options: {
    settings?: Partial<NotificationSettings>
    muted?: boolean
    hookRow?: AgentStatusIpcPayload | null
    dispatched?: boolean
    title?: string
  } = {}
) {
  const clock = { now: 10_000 }
  const sent: MobileNotificationDispatchEvent[] = []
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
  const state = {
    muted: options.muted ?? false,
    hasWindow: false,
    hookRow: options.hookRow ?? row()
  }
  const push = new TerminalAgentPhonePush({
    hasWindow: () => state.hasWindow,
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      agentNeedsInput: true,
      terminalBell: true,
      suppressWhenFocused: true,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: true,
      ...options.settings
    }),
    readWorkspaceLabels: () => ({ repoLabel: 'orca', worktreeLabel: 'feature' }),
    isWorkspaceMuted: () => state.muted,
    readOrchestration: () =>
      options.dispatched
        ? { taskId: 'task_1', dispatchId: 'ctx_1', parentTerminalHandle: 'term_coordinator' }
        : undefined,
    readTerminalTitle: () => options.title ?? null,
    readHookRow: () => state.hookRow,
    dispatch: (event) => sent.push(event),
    setTimer: (run, delayMs) => {
      const timer = { at: clock.now + delayMs, run, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    },
    now: () => clock.now
  })
  const advance = (ms: number): void => {
    clock.now += ms
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) {
        continue
      }
      if (timer.at <= clock.now) {
        timer.run()
      } else {
        timers.push(timer)
      }
    }
  }
  /** A live working row, as the detector reports every look. */
  const working = (overrides: Partial<AgentStatusIpcPayload> = {}): void => {
    state.hookRow = row({ state: 'working', stateStartedAt: 1_000, ...overrides })
    push.observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: WT, sshHostId: null },
      phase: 'working',
      at: 1
    })
  }
  const finish = (overrides: Partial<AgentStatusIpcPayload> = {}): void => {
    state.hookRow = row(overrides)
    push.observe(moved('turn-finished'))
  }
  return { push, sent, clock, state, advance, working, finish }
}

const ID = `agent:${encodeURIComponent(WT)}:${encodeURIComponent(PANE)}:5000`

describe('TerminalAgentPhonePush', () => {
  it('pushes a finish that followed live work once its quiet window passes, worded as the window', () => {
    const { push, sent, advance, working, finish } = harness()
    working()
    push.observe(moved('prompt-submitted', 'working'))
    finish()
    expect(sent).toEqual([])
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([
      {
        type: 'notification',
        source: 'agent-task-complete',
        title: 'orca / feature - Claude finished',
        body: 'Fixed it.',
        worktreeId: WT,
        paneKey: PANE,
        notificationId: ID,
        agentState: 'done',
        emittedAt: 11_500
      }
    ])
  })

  it('announces no milestone a goal agent resumes from within the quiet window', () => {
    const { push, sent, advance, working, finish } = harness()
    working()
    finish()
    advance(500)
    working()
    push.observe(moved(null, 'working'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('stays silent while a window owns the host, including one that arrives mid quiet window', () => {
    const { sent, state, advance, working, finish } = harness()
    state.hasWindow = true
    finish()
    expect(sent).toEqual([])
    state.hasWindow = false
    advance(5_000)
    working()
    finish({ stateStartedAt: 20_000 })
    state.hasWindow = true
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('announces a lead agent’s finish while background work runs, and not its later all-clear', () => {
    const { sent, advance, working, finish } = harness()
    working()
    working({ turnCompletedAt: 7_000 })
    // A background task's ping on the same turn is no news.
    working({ turnCompletedAt: 7_000 })
    expect(sent.map((event) => [event.agentState, event.notificationId])).toEqual([
      ['done', ID.replace(':5000', ':7000')]
    ])
    advance(5_000)
    finish({ stateStartedAt: 9_000, turnCompletedAt: 7_000 })
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toHaveLength(1)
  })

  it('announces no finish restored with the pane', () => {
    const { push, sent, advance, working, finish } = harness({
      hookRow: row({ state: 'working', turnCompletedAt: 7_000 })
    })
    const workspace = { worktreeId: WT, sshHostId: null }
    push.observe({ kind: 'seeded', paneKey: PANE, workspace, phase: 'working', at: 1 })
    working({ turnCompletedAt: 7_000 })
    finish({ turnCompletedAt: 7_000 })
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })
})
