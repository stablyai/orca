import { describe, expect, it } from 'vitest'
import { parseDaemonReadyIdentity } from './daemon-ready-identity'

describe('parseDaemonReadyIdentity', () => {
  it('accepts additive Linux incarnation identity', () => {
    expect(
      parseDaemonReadyIdentity({
        type: 'ready',
        startedAtMs: 1_700_000_000_000,
        linuxStartTicks: '4242',
        bootId: 'boot-a'
      })
    ).toEqual({
      startedAtMs: 1_700_000_000_000,
      linuxStartTicks: '4242',
      bootId: 'boot-a'
    })
  })

  it('keeps older ready payloads compatible', () => {
    expect(parseDaemonReadyIdentity({ type: 'ready', startedAtMs: 123 })).toEqual({
      startedAtMs: 123
    })
  })

  it('rejects partial Linux identity instead of persisting a false proof', () => {
    expect(
      parseDaemonReadyIdentity({
        type: 'ready',
        startedAtMs: 123,
        linuxStartTicks: '4242'
      })
    ).toBeNull()
  })
})
