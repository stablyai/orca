import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { stopAdoptedCodexTui } from './adopted-codex-tui-stop'

const IDENTITY = {
  hostId: 'local',
  pid: 5252,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'adopted-spawn'
}

const matched: AgentSessionOwnerProbe = {
  outcome: 'identity-matched',
  matchedOn: ['process-start-time']
}

describe('stopAdoptedCodexTui', () => {
  it('signals only after re-proving identity and returns only after proven absence', async () => {
    const events: string[] = []
    const proofs: AgentSessionOwnerProbe[] = [matched, matched, { outcome: 'pid-absent' }]

    await stopAdoptedCodexTui({
      identity: IDENTITY,
      probe: vi.fn(async () => {
        events.push('probe')
        return proofs.shift()!
      }),
      signal: vi.fn((_pid, signal) => events.push(signal)),
      sleep: vi.fn(async () => undefined),
      attempts: 3
    })

    expect(events).toEqual(['probe', 'SIGTERM', 'probe', 'probe'])
  })

  it('refuses to signal when the recorded process cannot be re-proved', async () => {
    const signal = vi.fn()
    const indeterminate: AgentSessionOwnerProbe = {
      outcome: 'indeterminate',
      reason: 'start time unavailable'
    }

    await expect(
      stopAdoptedCodexTui({
        identity: IDENTITY,
        probe: vi.fn(async () => indeterminate),
        signal
      })
    ).rejects.toThrow('could not be re-proved')
    expect(signal).not.toHaveBeenCalled()
  })

  it('refuses native ownership while the TUI remains live', async () => {
    const signal = vi.fn()

    await expect(
      stopAdoptedCodexTui({
        identity: IDENTITY,
        probe: vi.fn(async () => matched),
        signal,
        sleep: vi.fn(async () => undefined),
        attempts: 4
      })
    ).rejects.toThrow('exit could not be proven')
    expect(signal).toHaveBeenNthCalledWith(1, IDENTITY.pid, 'SIGTERM')
    expect(signal).toHaveBeenNthCalledWith(2, IDENTITY.pid, 'SIGKILL')
  })
})
