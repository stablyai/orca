import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import {
  clearDaemonReplacementDeferral,
  getDaemonReplacementDeferral,
  recordDaemonReplacementDeferral
} from './daemon-replacement-deferral'

describe('daemon replacement deferral', () => {
  const records: unknown[] = []
  const sink: TracerSink = {
    push: (record) => {
      records.push(record)
    },
    flush: vi.fn(),
    close: vi.fn()
  }

  beforeEach(() => {
    records.length = 0
    vi.mocked(sink.flush).mockClear()
    setActiveSink(sink)
    clearDaemonReplacementDeferral()
  })

  afterEach(() => {
    _resetTracerForTests()
    setActiveSink(null)
  })

  it('remembers the latest declined replacement for the renderer', () => {
    expect(getDaemonReplacementDeferral()).toBeNull()
    recordDaemonReplacementDeferral('stale_bundle', 2)
    recordDaemonReplacementDeferral('severed_tcc_attribution', 20)
    expect(getDaemonReplacementDeferral()).toMatchObject({
      reason: 'severed_tcc_attribution',
      liveSessionCount: 20
    })
    clearDaemonReplacementDeferral()
    expect(getDaemonReplacementDeferral()).toBeNull()
  })

  it('writes the decision to the trace file and flushes it immediately', () => {
    recordDaemonReplacementDeferral('severed_tcc_attribution', null)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      name: 'daemon.replacement_deferred',
      attributes: {
        'daemon.replace_reason': 'severed_tcc_attribution',
        'daemon.live_session_count': 'unverifiable'
      }
    })
    expect(sink.flush).toHaveBeenCalledTimes(1)
  })

  it('never lets diagnostics fail the daemon launch path', () => {
    setActiveSink({
      push: () => {
        throw new Error('disk full')
      },
      flush: () => {
        throw new Error('disk full')
      },
      close: () => {}
    })
    expect(() => recordDaemonReplacementDeferral('unhealthy_resolver', 1)).not.toThrow()
    expect(getDaemonReplacementDeferral()).toMatchObject({ reason: 'unhealthy_resolver' })
  })
})
