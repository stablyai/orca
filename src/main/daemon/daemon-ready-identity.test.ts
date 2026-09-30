import { describe, expect, it } from 'vitest'
import { parseDaemonReadyIdentity, readCurrentDaemonReadyIdentity } from './daemon-ready-identity'

describe('parseDaemonReadyIdentity', () => {
  it('accepts additive Linux incarnation identity', () => {
    expect(
      parseDaemonReadyIdentity({
        type: 'ready',
        pid: 4242,
        startedAtMs: 1_700_000_000_000,
        linuxStartTicks: '4242',
        bootId: 'boot-a'
      })
    ).toEqual({
      pid: 4242,
      startedAtMs: 1_700_000_000_000,
      linuxStartTicks: '4242',
      bootId: 'boot-a'
    })
  })

  it('accepts the minimal identity a non-Linux daemon reports', () => {
    expect(parseDaemonReadyIdentity({ type: 'ready', pid: 77, startedAtMs: 123 })).toEqual({
      pid: 77,
      startedAtMs: 123
    })
  })

  it('rejects a readiness payload with no self-reported PID', () => {
    // The launcher has no other trustworthy source: its own child may be the systemd-run
    // wrapper of a durable-scope launch rather than the daemon.
    expect(parseDaemonReadyIdentity({ type: 'ready', startedAtMs: 123 })).toBeNull()
  })

  it('rejects PIDs that cannot name a process', () => {
    for (const pid of [0, -1, 1.5, '123', Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseDaemonReadyIdentity({ type: 'ready', pid, startedAtMs: 123 })).toBeNull()
    }
  })

  it('rejects partial Linux identity instead of persisting a false proof', () => {
    expect(
      parseDaemonReadyIdentity({
        type: 'ready',
        pid: 4242,
        startedAtMs: 123,
        linuxStartTicks: '4242'
      })
    ).toBeNull()
  })
})

describe('readCurrentDaemonReadyIdentity', () => {
  it('reports the running process own PID, and the report round-trips through the parser', async () => {
    const identity = await readCurrentDaemonReadyIdentity(1_700_000_000_000)

    expect(identity.pid).toBe(process.pid)
    expect(parseDaemonReadyIdentity({ type: 'ready', ...identity })).toEqual(identity)
  })
})
