import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  normalizeAgentStatusPayload,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { evaluateHookTurn, readTuiIdleHookTurn } from './tui-idle-hook-lane'

const PANE = 'tab:11111111-1111-4111-8111-111111111111'

function pendingRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE,
    state: 'working',
    mainAgent: { state: 'done', stateStartedAt: now },
    prompt: '',
    agentType: 'claude',
    connectionId: 'host-a',
    launchToken: 'launch-a',
    claudeTaskWakeupPending: 'notification',
    providerSession: { key: 'session_id', id: 'session-a' },
    observation: {
      origin: 'hook',
      authorityId: 'host-a',
      incarnation: 1,
      revision: 1,
      observedAt: now
    },
    receivedAt: now,
    stateStartedAt: now,
    ...overrides
  }
}

function verdict(row: AgentStatusIpcPayload, blocked = false, titleObservedAtEpochMs?: number) {
  return evaluateHookTurn('claude', () =>
    readTuiIdleHookTurn({
      agent: 'claude',
      handles: [],
      paneKeys: [PANE],
      hookRows: [row],
      connectionId: 'host-a',
      launchToken: 'launch-a',
      titleObservedAtEpochMs,
      hasExplicitIdleTitle: titleObservedAtEpochMs !== undefined,
      resolveBlockedText: () => (blocked ? 'agent-interactive-prompt' : null)
    })
  )
}

describe('Claude task wake-up readiness authority', () => {
  it('vetoes rest from its own fresh hook without promoting ordinary Claude done to ready', () => {
    expect(verdict(pendingRow())).toEqual({ kind: 'working' })
    expect(verdict(pendingRow({ state: 'done', claudeTaskWakeupPending: undefined }))).toBeNull()
    expect(verdict(pendingRow({ claudeTaskWakeupPending: undefined }))).toBeNull()
  })

  it('reports an opaque child permission wait during the finishing turn', () => {
    expect(verdict(pendingRow({ state: 'waiting' }), true)).toEqual({
      kind: 'blocked',
      reason: 'agent-interactive-prompt'
    })
  })

  it.each([
    { connectionId: 'host-b' },
    { launchToken: 'old-launch' },
    { agentType: 'codex' },
    { providerSession: undefined },
    { providerSessionOnly: true },
    { restoredUnconfirmed: true },
    { observation: undefined },
    { paneKey: 'another-pane' }
  ])('does not take authority from an unmatched or unverifiable row: %j', (overrides) => {
    expect(verdict(pendingRow(overrides))).toBeNull()
  })

  it('allows a finishing turn’s fresh native rest when its Stop was lost, while owing still holds', () => {
    const finishing = pendingRow({ claudeTaskWakeupPending: 'finishing-turn', turnStartedAt: 10 })
    expect(verdict(finishing, false, 9)).toEqual({ kind: 'working' })
    expect(verdict(finishing, false, 10)).toEqual({ kind: 'working' })
    expect(verdict(finishing, false, 11)).toBeNull()
    expect(verdict(pendingRow(), false, 11)).toEqual({ kind: 'working' })
    const replay = pendingRow({ claudeTaskWakeupPending: 'finishing-turn' })
    expect(verdict(replay)).toEqual({ kind: 'working' })
    expect(verdict(replay, false, replay.receivedAt)).toEqual({ kind: 'working' })
    expect(verdict(replay, false, replay.receivedAt + 1)).toBeNull()
  })

  it('joins native, SSH and WSL execution hosts without accepting another distro', () => {
    for (const [connectionId, wslDistro, rowConnectionId, held] of [
      [null, null, null, true],
      ['ssh-a', 'Ubuntu', 'ssh-a', true],
      [null, 'Ubuntu', wslHookRelayConnectionId('Ubuntu'), true],
      [null, 'Ubuntu', wslHookRelayConnectionId('Debian'), false],
      ['ssh-a', 'Ubuntu', wslHookRelayConnectionId('Ubuntu'), false]
    ] as const) {
      const turn = readTuiIdleHookTurn({
        agent: 'claude',
        handles: [],
        paneKeys: [PANE],
        hookRows: [pendingRow({ connectionId: rowConnectionId })],
        connectionId,
        wslDistro,
        launchToken: 'launch-a',
        resolveBlockedText: () => null
      })
      expect(evaluateHookTurn('claude', () => turn)).toEqual(held ? { kind: 'working' } : null)
    }
  })

  it('uses evidence age rather than a reconnect receipt clock', () => {
    expect(
      verdict(pendingRow({ evidenceObservedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1 }))
    ).toBeNull()
  })

  it('accepts only known phases on a nonterminal Claude payload', () => {
    expect(normalizeAgentStatusPayload(pendingRow())).toHaveProperty(
      'claudeTaskWakeupPending',
      'notification'
    )
    for (const fields of [
      { claudeTaskWakeupPending: false },
      { claudeTaskWakeupPending: 'true' },
      { state: 'done' },
      { agentType: 'codex' }
    ]) {
      expect(normalizeAgentStatusPayload({ ...pendingRow(), ...fields })).not.toHaveProperty(
        'claudeTaskWakeupPending'
      )
    }
  })
})
