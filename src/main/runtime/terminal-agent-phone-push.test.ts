import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { AGENT_DONE_QUIET_MS, type AgentTransition } from '../../shared/agent-transitions'
import type { NotificationSettings } from '../../shared/notification-settings-types'
import type {
  MobileNotificationDispatchEvent,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
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
  _transition: AgentTransition | null,
  to: 'done' | 'needs-you' | 'working' | 'rest' = 'done'
): AgentPaneChange {
  return {
    kind: 'observed',
    paneKey: PANE,
    workspace: { worktreeId: WT, sshHostId: null },
    phase: to,
    at: Date.now()
  }
}

function harness(
  options: {
    settings?: Partial<NotificationSettings>
    muted?: boolean
    hookRow?: AgentStatusIpcPayload | null
  } = {}
) {
  const clock = {
    get now() {
      return Date.now()
    }
  }
  const sent: MobileNotificationDispatchEvent[] = []
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
    readHookRow: () => state.hookRow,
    dispatch: (event) => sent.push(event),
    retire: () => {},
    recordAnnounced: () => {},
    now: () => clock.now
  })
  cleanups.push(() => push.dispose())
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms)
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

const cleanups: (() => void)[] = []

describe('TerminalAgentPhonePush', () => {
  beforeEach(() => vi.useFakeTimers({ now: 10_000 }))
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    vi.useRealTimers()
  })
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

  it.each(['claude', 'pi'] as const)('seeds legacy %s history silently', (agentType) => {
    const { sent, advance, finish } = harness()
    finish({ agentType })
    expect(sent).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toHaveLength(0)
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

  it('pushes an agent that needs input at once, and a failed turn as finished', () => {
    const { push, sent, state, advance } = harness({
      hookRow: row({
        state: 'waiting',
        lastAssistantMessage: undefined,
        toolName: 'Bash',
        toolInput: 'rm -rf build'
      })
    })
    push.observe(moved('needs-input', 'needs-you'))
    expect(sent).toHaveLength(1)
    advance(5_000)
    state.hookRow = row({ mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 5_000 } })
    push.observe(moved('errored'))
    expect(sent.map((event) => [event.agentState, event.title, event.body])).toEqual([
      ['waiting', 'orca / feature - Claude needs input', 'Using Bash: rm -rf build'],
      ['done', 'orca / feature - Claude failed', 'Fixed it.']
    ])
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

  it('collapses a burst in one workspace as the window’s fan-out does', () => {
    const { sent, finish, working, advance } = harness()
    working()
    finish()
    advance(AGENT_DONE_QUIET_MS)
    working({ stateStartedAt: 5_500 })
    finish({ stateStartedAt: 6_000 })
    expect(vi.getTimerCount()).toBe(1)
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toHaveLength(1)
  })

  it('pushes nothing for a prompt, a resume, a rest, a session boundary, or a structured chat’s row', () => {
    const { push, sent, state, advance } = harness()
    push.observe(moved('prompt-submitted', 'working'))
    push.observe(moved(null, 'working'))
    push.observe(moved(null, 'rest'))
    // The detector names no news for a boundary's done.
    push.observe(moved(null, 'done'))
    push.observe({
      kind: 'seeded',
      paneKey: PANE,
      workspace: { worktreeId: WT, sshHostId: null },
      phase: 'done',
      at: 1
    })
    state.hookRow = row({ structuredHost: 'owned' })
    push.observe(moved('turn-finished'))
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('pushes nothing for a muted workspace', () => {
    const { sent, finish, working, advance } = harness({ muted: true })
    working()
    finish()
    expect(vi.getTimerCount()).toBe(1)
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toEqual([])
  })

  it('marks the push not desktop-allowed when agent notifications are off', () => {
    const { sent, finish, working, advance } = harness({ settings: { agentTaskComplete: false } })
    working()
    finish()
    advance(AGENT_DONE_QUIET_MS)
    expect(sent[0]?.desktopAllowed).toBe(false)
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

  it('waits out the quiet window for a pane restored mid-work, as the window seeds it', () => {
    const { push, sent, advance, finish } = harness({ hookRow: row({ state: 'working' }) })
    const workspace = { worktreeId: WT, sshHostId: null }
    push.observe({ kind: 'seeded', paneKey: PANE, workspace, phase: 'working', at: 1 })
    finish()
    expect(sent).toEqual([])
    advance(AGENT_DONE_QUIET_MS)
    expect(sent).toHaveLength(1)
  })

  it('counts a pane restored mid background work as work seen, as the window seeds it', () => {
    const { push, sent, advance, finish } = harness({
      hookRow: row({ state: 'working', turnCompletedAt: 7_000 })
    })
    const workspace = { worktreeId: WT, sshHostId: null }
    push.observe({ kind: 'seeded', paneKey: PANE, workspace, phase: 'working', at: 1 })
    finish()
    expect(sent).toEqual([])
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

  it('sends phones, old ones included, the alert the window’s own request would have', () => {
    const { sent, finish, working, advance } = harness()
    working()
    finish()
    advance(AGENT_DONE_QUIET_MS)
    const fromWindow: MobileNotificationEvent[] = []
    const service = createNotificationDeliveryService({
      readNotificationSettings: () => ({
        enabled: false,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: true,
        customSoundId: 'system',
        customSoundPath: null,
        customSoundVolume: 1,
        mutedNotificationSourceIds: [],
        notifyHiddenWorkspaces: true
      }),
      findActiveWindow: () => null,
      isWindowVisible: () => false,
      setTrayAttention: () => {},
      isNotificationSupported: () => false,
      dispatchMobileNotification: (event) => fromWindow.push(event),
      readAuthorizationStatus: async () => null,
      recordDeliveryOutcome: () => {},
      deliverNative: () => ({ delivered: false }),
      platform: 'linux',
      now: () => 11_500
    })
    void service.dispatch({
      source: 'agent-task-complete',
      notificationId: sent[0]?.notificationId,
      worktreeId: WT,
      paneKey: PANE,
      repoLabel: 'orca',
      worktreeLabel: 'feature',
      agentType: 'claude',
      agentState: 'done',
      agentPrompt: 'fix the bug',
      agentLastAssistantMessage: 'Fixed it.'
    })
    // The window's request was made with desktop banners off; only that flag differs.
    expect(fromWindow).toEqual([{ ...sent[0], desktopAllowed: false }])
  })
})
