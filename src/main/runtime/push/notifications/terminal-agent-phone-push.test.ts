import { describe, expect, it } from 'vitest'
import type {
  AgentPhase,
  AgentTransition
} from '../../../../shared/agent-status/lifecycle/agent-transitions'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { getDefaultNotificationSettings } from '../../../../shared/notifications/notification-settings-defaults'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { TerminalSideEffectFact } from '../../../../shared/terminal/output/terminal-side-effect-facts'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import { TerminalAgentPhonePush } from './terminal-agent-phone-push'

const WORKTREE = 'repo-1::/work/feature'
const workspace = { worktreeId: WORKTREE, sshHostId: null }

function windowlessHost(settings: { agentTaskComplete?: boolean } = {}) {
  let clock = 1_000_000
  let timers: { at: number; run: () => void; live: boolean }[] = []
  const hookRows = new Map<string, AgentStatusIpcPayload>()
  const sent: MobileNotificationDispatchEvent[] = []
  const clientListeners: ((event: RuntimeClientEvent) => void)[] = []
  const push = new TerminalAgentPhonePush({
    hasWindow: () => false,
    readNotificationSettings: () => ({
      ...getDefaultNotificationSettings(),
      terminalBell: true,
      ...settings
    }),
    readWorkspaceLabels: () => ({ worktreeLabel: 'feature' }),
    isWorkspaceMuted: () => false,
    readOrchestration: () => undefined,
    readTerminalTitle: () => null,
    readHookRow: (paneKey) => hookRows.get(paneKey) ?? null,
    dispatch: (event) => sent.push(event),
    onClientEvent: (listener) => {
      clientListeners.push(listener)
      return () => {}
    },
    setTimer: (run, delayMs) => {
      const timer = { at: clock + delayMs, run, live: true }
      timers.push(timer)
      return { cancel: () => (timer.live = false) }
    },
    now: () => clock
  })
  const advance = (ms: number) => {
    clock += ms
    const due = timers.filter((timer) => timer.live && timer.at <= clock)
    timers = timers.filter((timer) => !due.includes(timer))
    for (const timer of due) {
      timer.run()
    }
  }
  const moved = (paneKey: string, to: AgentPhase, transition: AgentTransition): void =>
    push.observe({ kind: 'moved', paneKey, workspace, from: 'working', to, at: clock, transition })
  const facts = (paneKey: string, ...chunk: TerminalSideEffectFact[]) =>
    clientListeners.forEach((listener) =>
      listener({
        type: 'terminalSideEffects',
        batch: {
          ptyId: 'pty',
          seq: 1,
          facts: chunk,
          worktreeId: WORKTREE,
          paneKey
        }
      })
    )
  return { push, hookRows, sent, advance, moved, facts, now: () => clock }
}

describe('TerminalAgentPhonePush on a windowless host', () => {
  it("pushes a hookless agent's title-only finish", () => {
    const host = windowlessHost()
    host.facts('tab-1:leaf-1', { kind: 'agent-working' })
    host.facts('tab-1:leaf-1', { kind: 'agent-idle', title: '◇ Ready (gemini)', status: 'idle' })
    host.advance(1500)
    expect(host.sent).toEqual([
      expect.objectContaining({ source: 'agent-task-complete', paneKey: 'tab-1:leaf-1' })
    ])
    expect(host.sent[0].agentState).toBeUndefined()
  })

  it("pushes a lone bell, but not one inside a hook-reported turn's burst", () => {
    const host = windowlessHost()
    host.facts('tab-1:leaf-1', { kind: 'bell' })
    host.advance(250)

    const waiting: AgentStatusIpcPayload = {
      paneKey: 'tab-2:leaf-1',
      state: 'waiting',
      prompt: 'deploy?',
      agentType: 'claude',
      connectionId: null,
      receivedAt: host.now(),
      stateStartedAt: host.now()
    }
    host.hookRows.set('tab-2:leaf-1', waiting)
    host.moved('tab-2:leaf-1', 'needs-you', 'needs-input')
    host.facts('tab-2:leaf-1', { kind: 'bell' })
    host.advance(250)

    expect(host.sent.map((event) => [event.source, event.paneKey])).toEqual([
      ['terminal-bell', 'tab-1:leaf-1'],
      ['agent-task-complete', 'tab-2:leaf-1']
    ])
  })

  it("carries a finish's reply that its transcript read adds within the quiet window", () => {
    const host = windowlessHost()
    const pane = 'tab-1:leaf-1'
    const turn = {
      paneKey: pane,
      agentType: 'droid',
      connectionId: null,
      prompt: 'fix it'
    } as const
    host.hookRows.set(pane, {
      ...turn,
      state: 'working',
      receivedAt: host.now(),
      stateStartedAt: host.now()
    })
    host.push.observe({
      kind: 'observed',
      paneKey: pane,
      workspace,
      phase: 'working',
      at: host.now()
    })
    const done: AgentStatusIpcPayload = {
      ...turn,
      state: 'done',
      receivedAt: host.now(),
      stateStartedAt: host.now(),
      turnCompletedAt: host.now()
    }
    host.hookRows.set(pane, done)
    host.moved(pane, 'done', 'turn-finished')
    host.advance(20)
    host.hookRows.set(pane, { ...done, lastAssistantMessage: 'All tests pass.' })
    host.advance(1500)
    expect(host.sent.map((event) => event.body)).toEqual([
      expect.stringContaining('All tests pass.')
    ])
  })

  it('rings a bell its finish held once the agent resumes work instead', () => {
    const host = windowlessHost()
    const idle: TerminalSideEffectFact = { kind: 'agent-idle', title: '◇ Ready (gemini)' }
    host.facts('tab-1:leaf-1', { kind: 'agent-working' })
    host.facts('tab-1:leaf-1', idle, { kind: 'bell' })
    host.advance(100)
    host.facts('tab-1:leaf-1', { kind: 'agent-working' })
    host.advance(1500)
    expect(host.sent.map((event) => event.source)).toEqual(['terminal-bell'])
  })

  it('rings the bell of a finish when finished alerts are off', () => {
    const host = windowlessHost({ agentTaskComplete: false })
    const idle: TerminalSideEffectFact = { kind: 'agent-idle', title: '◇ Ready (gemini)' }
    host.facts('tab-1:leaf-1', { kind: 'agent-working' })
    host.facts('tab-1:leaf-1', idle, { kind: 'bell' })
    host.advance(250)
    host.advance(1250)
    expect(host.sent.map((event) => [event.source, event.desktopAllowed])).toEqual([
      ['terminal-bell', undefined],
      ['agent-task-complete', false]
    ])
  })
})
