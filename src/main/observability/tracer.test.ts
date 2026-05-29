// Tracer tests: context propagation, exit-status recording, redaction
// integration. The sink is mocked so we can inspect the records that would
// have been pushed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetTracerForTests,
  getActiveSpanContext,
  setActiveSink,
  startSpan,
  withSpan,
  type TracerSink
} from './tracer'

type CapturedSink = TracerSink & {
  records: unknown[]
}

function makeCapturingSink(): CapturedSink {
  const records: unknown[] = []
  return {
    records,
    push(r) {
      records.push(r)
    },
    flush() {
      /* no-op */
    },
    close() {
      /* no-op */
    }
  }
}

let sink: CapturedSink

beforeEach(() => {
  sink = makeCapturingSink()
  setActiveSink(sink)
})
afterEach(() => {
  _resetTracerForTests()
})

describe('tracer — basic span lifecycle', () => {
  it('records a span on end()', () => {
    const span = startSpan('test')
    span.end()
    expect(sink.records).toHaveLength(1)
    const r = sink.records[0] as { type: string; name: string; exit: { _tag: string } }
    expect(r.type).toBe('effect-span')
    expect(r.name).toBe('test')
    expect(r.exit._tag).toBe('Success')
  })

  it('records Failure when fail() is called', () => {
    const span = startSpan('test')
    span.fail(new Error('boom'))
    const r = sink.records[0] as { exit: { _tag: string; cause: string } }
    expect(r.exit._tag).toBe('Failure')
    expect(r.exit.cause).toContain('boom')
  })

  it('records Interrupted on interrupt()', () => {
    const span = startSpan('test')
    span.interrupt('user-cancelled')
    const r = sink.records[0] as { exit: { _tag: string; cause: string } }
    expect(r.exit._tag).toBe('Interrupted')
    expect(r.exit.cause).toBe('user-cancelled')
  })

  it('end() is idempotent — second call is a no-op', () => {
    const span = startSpan('test')
    span.end()
    span.end()
    expect(sink.records).toHaveLength(1)
  })

  it('fail() after end() is a no-op (first end wins)', () => {
    const span = startSpan('test')
    span.end()
    span.fail('late')
    expect(sink.records).toHaveLength(1)
    const r = sink.records[0] as { exit: { _tag: string } }
    expect(r.exit._tag).toBe('Success')
  })
})

describe('tracer — attributes and events', () => {
  it('captures attributes set before end()', () => {
    const span = startSpan('test', { attributes: { initial: true } })
    span.setAttribute('mid', 42)
    span.end()
    const r = sink.records[0] as { attributes: Record<string, unknown> }
    expect(r.attributes.initial).toBe(true)
    expect(r.attributes.mid).toBe(42)
  })

  it('captures events with redacted attribute values', () => {
    const span = startSpan('test')
    span.addEvent('log', { 'log.message': `sk-ant-${'a'.repeat(50)}` })
    span.end()
    const r = sink.records[0] as {
      events: { name: string; attributes: Record<string, string> }[]
    }
    expect(r.events).toHaveLength(1)
    expect(r.events[0].name).toBe('log')
    expect(r.events[0].attributes['log.message']).toContain('[redacted:anthropic-key]')
  })

  it('drops blocklisted attribute keys', () => {
    const span = startSpan('test', { attributes: { authorization: 'Bearer x', cwd: '/repo' } })
    span.end()
    const r = sink.records[0] as { attributes: Record<string, unknown> }
    expect(r.attributes).not.toHaveProperty('authorization')
    expect(r.attributes.cwd).toBe('/repo')
  })
})

describe('tracer — context propagation via AsyncLocalStorage', () => {
  it('child span inherits parent traceId', async () => {
    await withSpan('outer', async () => {
      const outerCtx = getActiveSpanContext()
      expect(outerCtx).toBeDefined()
      await withSpan('inner', async () => {
        const innerCtx = getActiveSpanContext()
        expect(innerCtx?.traceId).toBe(outerCtx?.traceId)
        // spanId should be different — inner has its own.
        expect(innerCtx?.spanId).not.toBe(outerCtx?.spanId)
      })
    })

    // Two records: inner first (it ended first), then outer.
    expect(sink.records).toHaveLength(2)
    const inner = sink.records[0] as {
      name: string
      traceId: string
      parentSpanId?: string
    }
    const outer = sink.records[1] as { name: string; traceId: string; spanId: string }
    expect(inner.name).toBe('inner')
    expect(outer.name).toBe('outer')
    expect(inner.traceId).toBe(outer.traceId)
    expect(inner.parentSpanId).toBe(outer.spanId)
  })

  it('a top-level span has no parentSpanId', async () => {
    await withSpan('top', async () => {
      /* */
    })
    const r = sink.records[0] as { parentSpanId?: string }
    expect(r.parentSpanId).toBeUndefined()
  })
})

describe('tracer — withSpan auto-fail on throw', () => {
  it('records Failure when fn throws and re-throws', async () => {
    await expect(
      withSpan('throws', async () => {
        throw new Error('kaboom')
      })
    ).rejects.toThrow('kaboom')
    const r = sink.records[0] as { exit: { _tag: string; cause: string } }
    expect(r.exit._tag).toBe('Failure')
    expect(r.exit.cause).toContain('kaboom')
  })

  it('records Success when fn returns', async () => {
    const result = await withSpan('ok', async () => 42)
    expect(result).toBe(42)
    const r = sink.records[0] as { exit: { _tag: string } }
    expect(r.exit._tag).toBe('Success')
  })
})

describe('tracer — no-op when sink is unset', () => {
  it('returns a no-op span and writes nothing', () => {
    setActiveSink(null)
    const span = startSpan('detached')
    span.setAttribute('x', 1)
    span.fail('whatever')
    // Nothing observable happens.
    expect(sink.records).toHaveLength(0)
  })
})
