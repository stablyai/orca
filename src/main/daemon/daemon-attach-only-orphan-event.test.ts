import { describe, expect, it, vi } from 'vitest'

const trackMock = vi.hoisted(() => vi.fn())
vi.mock('../telemetry/client', () => ({ track: trackMock }))

import {
  classifyAttachOnlyKillError,
  trackAttachOnlyOrphanRisk
} from './daemon-attach-only-orphan-event'

describe('classifyAttachOnlyKillError', () => {
  it('buckets kill failures without free text', () => {
    expect(classifyAttachOnlyKillError(new Error('Not connected'))).toBe('transport')
    expect(classifyAttachOnlyKillError(new Error('Connection lost'))).toBe('transport')
    expect(classifyAttachOnlyKillError(new Error('Disconnected'))).toBe('transport')
    expect(classifyAttachOnlyKillError(new Error('request timed out'))).toBe('timeout')
    expect(classifyAttachOnlyKillError(new Error('Session not found: x'))).toBe('not_found')
    expect(classifyAttachOnlyKillError(new Error('weird'))).toBe('unknown')
  })

  it('classifies rejection values whose string conversion throws as unknown', () => {
    const rejection = {
      [Symbol.toPrimitive]: () => {
        throw new Error('conversion failed')
      }
    }
    expect(classifyAttachOnlyKillError(rejection)).toBe('unknown')
  })
})

describe('trackAttachOnlyOrphanRisk', () => {
  it('emits the closed telemetry shape', () => {
    trackMock.mockClear()
    trackAttachOnlyOrphanRisk({ protocolVersion: 30, killErrorClass: 'transport' })
    expect(trackMock).toHaveBeenCalledWith('daemon_attach_only_orphan_risk', {
      protocol_version: 30,
      kill_error_class: 'transport'
    })
  })
})
