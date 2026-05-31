import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { RedactableSpan } from './redactor'

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn()
}))

vi.mock('node:http', () => ({ request: httpRequestMock }))
vi.mock('node:https', () => ({ request: httpsRequestMock }))

import { createOtlpExporter } from './otlp-exporter'

class FakeRequest extends EventEmitter {
  destroy = vi.fn()
  end = vi.fn()
  write = vi.fn()
}

class FakeResponse extends EventEmitter {
  statusCode = 204
  resume = vi.fn()
}

function span(): RedactableSpan {
  return {
    name: 'unit',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: '1000',
    endTimeUnixNano: '2000',
    durationMs: 1,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' }
  }
}

describe('otlp exporter HTTP cleanup', () => {
  it('removes request listeners after a successful export response', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    let responseCallback: ((response: FakeResponse) => void) | null = null
    httpRequestMock.mockImplementationOnce(
      (_options: unknown, callback: (response: FakeResponse) => void) => {
        responseCallback = callback
        return request
      }
    )

    const exporter = createOtlpExporter({
      tracesUrl: 'http://collector.example/v1/traces',
      serviceName: 'orca-test',
      timeoutMs: 1000
    })
    exporter.exportSpan(span())
    const flush = exporter.flush()

    expect(request.listenerCount('error')).toBe(1)
    expect(request.listenerCount('timeout')).toBe(1)
    const respond = responseCallback as ((response: FakeResponse) => void) | null
    if (!respond) {
      throw new Error('HTTP response callback was not registered')
    }
    respond(response)

    await flush
    exporter.close()
    expect(response.resume).toHaveBeenCalledTimes(1)
    expect(request.listenerCount('error')).toBe(0)
    expect(request.listenerCount('timeout')).toBe(0)
  })

  it('removes request listeners after an export timeout', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const request = new FakeRequest()
      httpRequestMock.mockReturnValueOnce(request)

      const exporter = createOtlpExporter({
        tracesUrl: 'http://collector.example/v1/traces',
        serviceName: 'orca-test',
        timeoutMs: 1000
      })
      exporter.exportSpan(span())
      const flush = exporter.flush()

      request.emit('timeout')

      await flush
      exporter.close()
      expect(request.destroy).toHaveBeenCalledTimes(1)
      expect(request.listenerCount('error')).toBe(0)
      expect(request.listenerCount('timeout')).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
