// OTLP exporter tests. Most cases lock the wire encoding; the flush suite uses
// a local HTTP server to verify batching without requiring an LGTM container.

import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { _internalsForTests, createOtlpExporter, createOtlpExporterFromEnv } from './otlp-exporter'
import type { RedactableSpan } from './redactor'

const { encodeOtlpPayload, toOtlpAttributes, spanKindToOtlp } = _internalsForTests

let server: Server | null = null

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) {
        resolve()
        return
      }
      server.close(() => {
        server = null
        resolve()
      })
    })
)

function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler)
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (address && typeof address === 'object') {
        resolve(`http://127.0.0.1:${address.port}`)
      }
    })
  })
}

function span(overrides: Partial<RedactableSpan> = {}): RedactableSpan {
  return {
    name: 'unit',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: '1000',
    endTimeUnixNano: '2000',
    durationMs: 1.0,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  }
}

describe('otlp-exporter — env gating', () => {
  it('returns null when ORCA_OTLP_TRACES_URL is unset', () => {
    const before = process.env.ORCA_OTLP_TRACES_URL
    delete process.env.ORCA_OTLP_TRACES_URL
    expect(createOtlpExporterFromEnv()).toBeNull()
    if (before !== undefined) {
      process.env.ORCA_OTLP_TRACES_URL = before
    }
  })
})

describe('otlp-exporter — flushing', () => {
  it('serializes batch POSTs and awaits in-flight flushes', async () => {
    let activeRequests = 0
    let maxConcurrentRequests = 0
    let requestCount = 0
    const baseUrl = await listen((req, res) => {
      req.resume()
      requestCount += 1
      activeRequests += 1
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests)
      setTimeout(() => {
        activeRequests -= 1
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      }, 20)
    })
    const exporter = createOtlpExporter({
      tracesUrl: `${baseUrl}/v1/traces`,
      serviceName: 'orca-test',
      timeoutMs: 1_000
    })

    for (let i = 0; i < 128; i++) {
      exporter.exportSpan(span({ spanId: i.toString(16).padStart(16, '0') }))
    }
    await exporter.flush()
    exporter.close()

    expect(requestCount).toBe(2)
    expect(maxConcurrentRequests).toBe(1)
  })

  it('caps queued spans and keeps the newest records', async () => {
    const receivedSpanIds: string[] = []
    const baseUrl = await listen((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const payload = JSON.parse(body) as ReturnType<typeof encodeOtlpPayload>
        receivedSpanIds.push(
          ...payload.resourceSpans.flatMap((resourceSpan) =>
            resourceSpan.scopeSpans.flatMap((scopeSpan) =>
              scopeSpan.spans.map((exportedSpan) => exportedSpan.spanId)
            )
          )
        )
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })
    })
    const exporter = createOtlpExporter({
      tracesUrl: `${baseUrl}/v1/traces`,
      serviceName: 'orca-test',
      timeoutMs: 1_000,
      maxQueueSpans: 4
    })

    for (let i = 0; i < 6; i++) {
      exporter.exportSpan(span({ spanId: i.toString(16).padStart(16, '0') }))
    }
    await exporter.flush()
    exporter.close()

    expect(receivedSpanIds).toEqual([
      '0000000000000002',
      '0000000000000003',
      '0000000000000004',
      '0000000000000005'
    ])
  })
})

describe('otlp-exporter — attribute encoding', () => {
  it('encodes strings, ints, floats, bools', () => {
    const out = toOtlpAttributes({ s: 'x', i: 5, f: 1.5, b: true })
    expect(out).toEqual([
      { key: 's', value: { stringValue: 'x' } },
      { key: 'i', value: { intValue: '5' } },
      { key: 'f', value: { doubleValue: 1.5 } },
      { key: 'b', value: { boolValue: true } }
    ])
  })
  it('JSON-encodes objects and arrays', () => {
    const out = toOtlpAttributes({ list: [1, 2], obj: { a: 1 } })
    expect(out).toContainEqual({ key: 'list', value: { stringValue: '[1,2]' } })
    expect(out).toContainEqual({ key: 'obj', value: { stringValue: '{"a":1}' } })
  })
  it('drops null/undefined', () => {
    const out = toOtlpAttributes({ keep: 'x', drop: null, alsodrop: undefined })
    expect(out.find((kv) => kv.key === 'drop')).toBeUndefined()
    expect(out.find((kv) => kv.key === 'alsodrop')).toBeUndefined()
    expect(out.find((kv) => kv.key === 'keep')).toBeDefined()
  })
})

describe('otlp-exporter — span kind mapping', () => {
  it('maps OTel SpanKind names to numeric codes', () => {
    expect(spanKindToOtlp('internal')).toBe(1)
    expect(spanKindToOtlp('server')).toBe(2)
    expect(spanKindToOtlp('client')).toBe(3)
    expect(spanKindToOtlp('producer')).toBe(4)
    expect(spanKindToOtlp('consumer')).toBe(5)
    expect(spanKindToOtlp('unknown')).toBe(1)
  })
})

describe('otlp-exporter — payload encoding', () => {
  it('builds a valid OTLP payload skeleton with service.name', () => {
    const out = encodeOtlpPayload('orca-test', [span()])
    expect(out.resourceSpans).toHaveLength(1)
    expect(out.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'orca-test' }
    })
    expect(out.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1)
  })

  it('includes parentSpanId when present', () => {
    const out = encodeOtlpPayload('s', [span({ parentSpanId: 'p'.repeat(16) })])
    const s = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.parentSpanId).toBe('p'.repeat(16))
  })

  it('omits parentSpanId for root spans', () => {
    const out = encodeOtlpPayload('s', [span()])
    const s = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.parentSpanId).toBeUndefined()
  })

  it('sets ERROR status on Failure exits', () => {
    const out = encodeOtlpPayload('s', [span({ exit: { _tag: 'Failure', cause: 'boom' } })])
    const s = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.status?.code).toBe(2)
    expect(s.status?.message).toBe('boom')
  })

  it('omits status for Success exits', () => {
    const out = encodeOtlpPayload('s', [span()])
    const s = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.status).toBeUndefined()
  })

  it('encodes events with their attributes', () => {
    const out = encodeOtlpPayload('s', [
      span({
        events: [{ name: 'log', timeUnixNano: '1500', attributes: { msg: 'hi' } }]
      })
    ])
    const s = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.events).toHaveLength(1)
    expect(s.events[0].name).toBe('log')
    expect(s.events[0].timeUnixNano).toBe('1500')
    expect(s.events[0].attributes).toContainEqual({
      key: 'msg',
      value: { stringValue: 'hi' }
    })
  })
})
