import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'
import { buildRelayHookEnvelope } from '../../relay/agent-hook-envelope-build'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const time = 1_800_000_000_000
const envelope = {
  source: 'opencode',
  paneKey: PANE,
  worktreeId: 'workspace',
  connectionId: null,
  launchToken: 'generation',
  payload: { agentType: 'opencode', state: 'waiting', prompt: 'approval' }
} as const
const unavailable = { ...envelope, statusUnavailable: true, payload: null } as const

describe('optional tmux projection wire metadata', () => {
  let server: AgentHookServer
  beforeEach(() => {
    _internals.resetCachesForTests()
    vi.useFakeTimers()
    vi.setSystemTime(time)
    server = new AgentHookServer()
  })
  afterEach(() => {
    server.stop()
    vi.useRealTimers()
  })
  it('preserves host evidence age while keeping local delivery order current', () => {
    server.ingestRemote({ ...envelope, evidenceAgeMs: 60_000 }, 'connection')
    const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
    expect(row?.evidenceObservedAt).toBe(time - 60_000)
    expect(row?.receivedAt).toBe(time)
    vi.setSystemTime(time + 10_000)
    server.ingestRemote({ ...envelope, evidenceAgeMs: 70_000, isReplay: true }, 'connection')
    expect(
      server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)?.evidenceObservedAt
    ).toBe(time - 60_000)
  })
  it('clears a selected projection only for the matching host, workspace and generation', () => {
    server.ingestRemote(envelope, 'connection')
    server.ingestRemote(unavailable, 'old-connection')
    server.ingestRemote({ ...unavailable, launchToken: 'old-generation' }, 'connection')
    server.ingestRemote({ ...unavailable, worktreeId: 'foreign' }, 'connection')
    expect(server.getStatusSnapshot()).toHaveLength(1)
    server.ingestRemote(unavailable, 'connection')
    expect(server.getStatusSnapshot()).toHaveLength(0)
  })
  it('accepts old relay envelopes and ignores unknown null payloads without fabricating Done', () => {
    server.ingestRemote(envelope, 'connection')
    expect(server.getStatusSnapshot()[0]?.evidenceObservedAt).toBe(time)
    server.ingestRemote({ ...unavailable, statusUnavailable: undefined }, 'connection')
    expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')
  })
  it('rejects invalid ages and never forwards absolute host clocks', () => {
    for (const age of [-1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      server.ingestRemote({ ...envelope, evidenceAgeMs: age }, 'connection')
    }
    expect(server.getStatusSnapshot()).toHaveLength(0)
    const built = buildRelayHookEnvelope(
      { ...envelope, hostEvidenceObservedAt: time - 1000 },
      'opencode'
    )
    expect(built.evidenceAgeMs).toBe(1000)
    expect(built).not.toHaveProperty('hostEvidenceObservedAt')
    vi.setSystemTime(time + 1000)
    expect(
      buildRelayHookEnvelope(
        { ...envelope, hostEvidenceObservedAt: time - 1000 },
        'opencode',
        undefined,
        undefined,
        { isReplay: true }
      ).evidenceAgeMs
    ).toBe(2000)
  })
})
