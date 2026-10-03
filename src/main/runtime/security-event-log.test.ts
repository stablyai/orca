import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import {
  disableSecurityEventLog,
  enableSecurityEventLog,
  recordSecurityEvent,
  SECURITY_EVENT_PREFIX,
  type SecurityEvent
} from './security-event-log'

let lines: string[]
let clock: number

function events(): Record<string, unknown>[] {
  return lines.map((line) => {
    expect(line.startsWith(SECURITY_EVENT_PREFIX)).toBe(true)
    const record: unknown = JSON.parse(line.slice(SECURITY_EVENT_PREFIX.length))
    return record !== null && typeof record === 'object'
      ? Object.fromEntries(Object.entries(record))
      : {}
  })
}

// Why a helper: these tests vary only how many drops a window produces, not the payload.
function rejection(): SecurityEvent {
  return { event: 'connection_rejected', transport: 'direct', code: 4001, reason: 'Unauthorized' }
}

beforeEach(() => {
  lines = []
  clock = 1_000_000
  enableSecurityEventLog({ write: (line) => lines.push(line), now: () => clock, limitPerMinute: 3 })
})

afterEach(() => {
  disableSecurityEventLog()
})

describe('recordSecurityEvent', () => {
  it('is silent unless a host enabled it', () => {
    disableSecurityEventLog()
    recordSecurityEvent({ event: 'device_removed', deviceId: 'd', scope: 'runtime' })
    expect(lines).toEqual([])
  })

  it('caps events per minute and reports how many it dropped', () => {
    for (let i = 0; i < 5; i += 1) {
      recordSecurityEvent({
        event: 'connection_rejected',
        transport: 'direct',
        code: 4001,
        reason: 'Unauthorized'
      })
    }
    expect(events()).toHaveLength(3)
    clock += 60_000
    recordSecurityEvent({
      event: 'connection_rejected',
      transport: 'direct',
      code: 4001,
      reason: 'Unauthorized'
    })
    expect(
      events()
        .slice(3)
        .map((e) => e.event)
    ).toEqual(['events_suppressed', 'connection_rejected'])
    expect(events()[3]).toMatchObject({ count: 2 })
  })

  it('reports the suppressed tail when the window ends without another event', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 5; i += 1) {
        recordSecurityEvent(rejection())
      }
      expect(events()).toHaveLength(3)

      clock += 60_000
      vi.advanceTimersByTime(60_000)

      expect(events().slice(3)).toEqual([
        expect.objectContaining({ event: 'events_suppressed', group: 'rejections', count: 2 })
      ])
      // Why: the flush must restart the window, or the next event would report the same drops again.
      recordSecurityEvent(rejection())
      expect(events()).toHaveLength(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the suppressed tail when the log is disabled mid-window', () => {
    for (let i = 0; i < 5; i += 1) {
      recordSecurityEvent(rejection())
    }

    disableSecurityEventLog()

    expect(events()).toHaveLength(4)
    expect(events()[3]).toMatchObject({
      event: 'events_suppressed',
      group: 'rejections',
      count: 2
    })
  })

  it('gives refusals their own budget so they cannot starve operator events', () => {
    enableSecurityEventLog({ write: (line) => lines.push(line), now: () => clock })
    for (let i = 0; i < 100; i += 1) {
      recordSecurityEvent(rejection())
    }
    recordSecurityEvent({ event: 'device_paired', deviceId: 'd', scope: 'runtime' })

    const recorded = events()
    expect(recorded.filter((event) => event.event === 'connection_rejected')).toHaveLength(60)
    expect(recorded.at(-1)).toMatchObject({ event: 'device_paired', deviceId: 'd' })
  })

  it('never lets a failing sink throw into pairing or connections', () => {
    enableSecurityEventLog({
      write: () => {
        throw new Error('stderr closed')
      }
    })
    expect(() =>
      recordSecurityEvent({ event: 'device_removed', deviceId: 'd', scope: 'runtime' })
    ).not.toThrow()
  })
})

describe('DeviceRegistry security events', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-security-events-'))
    enableSecurityEventLog({ write: (line) => lines.push(line), now: () => clock })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('records offer issue, rotation, first use and removal without any token', () => {
    const registry = new DeviceRegistry(dir)
    const first = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network')
    const rotated = registry.rotatePendingDevice('CLI', 'runtime', 'network')
    registry.updateLastSeen(rotated.deviceId)
    registry.updateLastSeen(rotated.deviceId)
    registry.removeDevice(rotated.deviceId)

    expect(events().map(({ ts: _ts, ...event }) => event)).toEqual([
      {
        event: 'pairing_offer_issued',
        deviceId: first.deviceId,
        scope: 'runtime',
        reach: 'network',
        invalidatedPending: 0
      },
      {
        event: 'pairing_offer_issued',
        deviceId: rotated.deviceId,
        scope: 'runtime',
        reach: 'network',
        invalidatedPending: 1
      },
      { event: 'device_paired', deviceId: rotated.deviceId, scope: 'runtime' },
      { event: 'device_removed', deviceId: rotated.deviceId, scope: 'runtime' }
    ])
    const text = lines.join('\n')
    expect(text).not.toContain(first.token)
    expect(text).not.toContain(rotated.token)
  })

  it('does not record a removal of an unknown device', () => {
    const registry = new DeviceRegistry(dir)
    expect(registry.removeDevice('missing')).toBe(false)
    expect(lines).toEqual([])
  })
})
