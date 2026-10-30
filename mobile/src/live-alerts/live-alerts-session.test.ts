import { describe, expect, it } from 'vitest'
import type { LiveAgent, LivePhase } from './live-alert-types'
import {
  DISCONNECT_END_MS,
  DONE_LINGER_MS,
  LiveAlertsSession,
  type LiveSessionInput,
  type LiveSessionStep
} from './live-alerts-session'

function agent(key: string, phase: LivePhase, hostId = 'host-1'): LiveAgent {
  return {
    key,
    hostId,
    hostName: 'Desk',
    worktreeId: 'wt-1',
    workspace: 'demo-repo',
    executionHost: null,
    paneKey: key,
    phase,
    need: phase === 'waiting' ? 'input' : null,
    agentType: 'opencode',
    prompt: '',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    stateStartedAt: 0,
    updatedAt: 0
  }
}

function step(
  session: LiveAlertsSession,
  now: number,
  agents: LiveAgent[],
  extra: Partial<LiveSessionInput> = {}
): LiveSessionStep {
  return session.step({
    now,
    allowed: true,
    agents,
    staleHostIds: new Set<string>(),
    pendingHostIds: new Set<string>(),
    lastSuccessAt: new Map([['host-1', now]]),
    ...extra
  })
}

function keysOf(result: LiveSessionStep): string[] {
  return 'session' in result ? [...result.session.sessionKeys] : []
}

describe('LiveAlertsSession', () => {
  it('starts with the first active agent and stays live while it works', () => {
    const session = new LiveAlertsSession()
    expect(step(session, 0, [agent('a', 'done')])).toEqual({ kind: 'none' })
    const started = step(session, 1, [agent('a', 'working')])
    expect(started).toMatchObject({ kind: 'show', mode: 'live', session: { startedAt: 1 } })
    expect(session.isShowing()).toBe(true)
    const waiting = step(session, 2, [agent('a', 'waiting')])
    expect(waiting).toMatchObject({ kind: 'show', mode: 'live', session: { startedAt: 1 } })
  })

  it('does not start from old rows that are being refreshed', () => {
    const session = new LiveAlertsSession()
    const pending = { pendingHostIds: new Set(['host-1']) }
    expect(step(session, 0, [agent('a', 'working')], pending)).toEqual({ kind: 'none' })
    expect(step(session, 1, [agent('a', 'working')]).kind).toBe('show')
  })

  it('lingers on Done, then finishes', () => {
    const session = new LiveAlertsSession()
    step(session, 0, [agent('a', 'working')])
    const lingering = step(session, 1_000, [agent('a', 'done')])
    expect(lingering).toMatchObject({ kind: 'show', mode: 'lingering' })
    expect(step(session, 1_000 + DONE_LINGER_MS - 1, [agent('a', 'done')]).kind).toBe('show')
    const finished = step(session, 1_000 + DONE_LINGER_MS, [agent('a', 'done')])
    expect(finished).toMatchObject({ kind: 'finish', final: 'done', session: { startedAt: 0 } })
    expect(session.isShowing()).toBe(false)
  })

  it('keeps one session when a new turn starts during the linger', () => {
    const session = new LiveAlertsSession()
    step(session, 0, [agent('a', 'working')])
    step(session, 1_000, [agent('a', 'done')])
    const resumed = step(session, 2_000, [agent('a', 'working'), agent('b', 'working')])
    expect(resumed).toMatchObject({ kind: 'show', mode: 'live', session: { startedAt: 0 } })
    expect(keysOf(resumed)).toEqual(['a', 'b'])
  })

  it('stays quiet after a dismissal until no agent is active', () => {
    const session = new LiveAlertsSession()
    step(session, 0, [agent('a', 'working')])
    session.dismissed()
    expect(session.isShowing()).toBe(false)
    expect(step(session, 1, [agent('a', 'working')])).toEqual({ kind: 'none' })
    expect(step(session, 2, [agent('a', 'done')])).toEqual({ kind: 'none' })
    expect(step(session, 3, [agent('a', 'working')]).kind).toBe('show')
  })

  it('cancels once when the setting is turned off', () => {
    const session = new LiveAlertsSession()
    const off = { allowed: false }
    step(session, 0, [agent('a', 'working')])
    expect(step(session, 1, [agent('a', 'working')], off)).toEqual({ kind: 'cancel' })
    expect(step(session, 2, [agent('a', 'working')], off)).toEqual({ kind: 'none' })
  })

  it('shows a disconnect while the host is unreadable, then ends after 90 s', () => {
    const session = new LiveAlertsSession()
    step(session, 0, [agent('a', 'working')])
    const stale = { staleHostIds: new Set(['host-1']), lastSuccessAt: new Map([['host-1', 0]]) }
    const lost = step(session, 40_000, [agent('a', 'working')], stale)
    expect(lost).toMatchObject({ kind: 'show', mode: 'disconnected' })
    const ended = step(session, DISCONNECT_END_MS, [agent('a', 'working')], stale)
    expect(ended).toMatchObject({ kind: 'finish', final: 'disconnected' })
    expect(session.isShowing()).toBe(false)
  })

  it('ignores a stale host whose agents never joined the session', () => {
    const session = new LiveAlertsSession()
    const stale = { staleHostIds: new Set(['host-2']) }
    const other = agent('z', 'working', 'host-2')
    expect(step(session, 0, [other], stale)).toEqual({ kind: 'none' })
    step(session, 1, [agent('a', 'working'), other], stale)
    const lingering = step(session, 2, [agent('a', 'done'), other], stale)
    expect(lingering).toMatchObject({ kind: 'show', mode: 'lingering' })
    expect(keysOf(lingering)).toEqual(['a'])
  })
})
