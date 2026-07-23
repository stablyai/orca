import { describe, expect, it } from 'vitest'
import {
  buildBoundedCdpConsoleEntry,
  buildBoundedCdpInterceptedRequest,
  buildBoundedCdpNetworkEntry,
  CDP_MAX_CAPTURE_URL_CODE_UNITS,
  CDP_MAX_CONSOLE_ARGUMENTS,
  CDP_MAX_CONSOLE_TEXT_CODE_UNITS,
  CDP_MAX_INTERCEPTED_HEADERS,
  CDP_MAX_INTERCEPTED_METADATA_CODE_UNITS
} from './cdp-event-memory-bounds'

describe('CDP event memory bounds', () => {
  it('preserves ordinary console and network capture fields', () => {
    expect(
      buildBoundedCdpConsoleEntry({
        type: 'warning',
        args: [{ value: 'hello' }, { value: 42 }],
        timestamp: 123,
        stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 7 }] }
      })
    ).toEqual({
      level: 'warning',
      text: 'hello 42',
      timestamp: 123,
      url: 'https://example.com/app.js',
      line: 7
    })
    expect(
      buildBoundedCdpNetworkEntry(
        { url: 'https://example.com/data', status: 200, mimeType: 'application/json' },
        456
      )
    ).toEqual({
      url: 'https://example.com/data',
      method: '',
      status: 200,
      mimeType: 'application/json',
      size: 0,
      timestamp: 456
    })
  })

  it('bounds console argument count, joined text, and capture URLs', () => {
    const entry = buildBoundedCdpConsoleEntry({
      args: Array.from({ length: CDP_MAX_CONSOLE_ARGUMENTS + 100 }, () => ({
        value: 'x'.repeat(100)
      })),
      stackTrace: { callFrames: [{ url: 'u'.repeat(CDP_MAX_CAPTURE_URL_CODE_UNITS + 100) }] }
    })

    expect(entry.text.length).toBeLessThanOrEqual(CDP_MAX_CONSOLE_TEXT_CODE_UNITS)
    expect(entry.url).toHaveLength(CDP_MAX_CAPTURE_URL_CODE_UNITS)
  })

  it('rejects intercepted metadata beyond aggregate and header-count caps', () => {
    expect(
      buildBoundedCdpInterceptedRequest({
        requestId: 'request-1',
        request: { url: 'https://example.com', headers: { accept: '*/*' } }
      })
    ).toEqual({
      id: 'request-1',
      url: 'https://example.com',
      method: 'GET',
      headers: { accept: '*/*' },
      resourceType: 'Other'
    })

    expect(
      buildBoundedCdpInterceptedRequest({
        requestId: 'request-2',
        request: { url: 'u'.repeat(CDP_MAX_INTERCEPTED_METADATA_CODE_UNITS + 1) }
      })
    ).toBeNull()

    const headers = Object.fromEntries(
      Array.from({ length: CDP_MAX_INTERCEPTED_HEADERS + 1 }, (_, index) => [`x-${index}`, 'v'])
    )
    expect(
      buildBoundedCdpInterceptedRequest({ requestId: 'request-3', request: { headers } })
    ).toBeNull()
  })
})
