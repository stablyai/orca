import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBundleManifest } from '../../../shared/mobile-web-bundle/manifest-contract'
import {
  type MobileClientMethodKind,
  MOBILE_CLIENT_FIRST_CALL_LINE_CAP,
  MOBILE_CLIENT_PENDING_LINE_CAP,
  MOBILE_CLIENT_PENDING_REPORT_MS,
  MobileClientTraceRegistry
} from './mobile-client-trace'
import {
  MOBILE_CLIENT_TRACE_WINDOW_LINES,
  MOBILE_CLIENT_TRACE_WINDOW_MS,
  MobileClientTraceLog
} from './mobile-client-trace-log'

const BUILD_ID = 'abcdef0123456789'.repeat(4)

function manifestOf(assets: { path: string; byteLength: number }[]): MobileWebBundleManifest {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trace reads only buildId and assets' path/byteLength; routes and hashes are irrelevant here.
  return {
    buildId: BUILD_ID,
    assets: assets.map((asset) => ({ ...asset, sha256: '0'.repeat(64) }))
  } as unknown as MobileWebBundleManifest
}

function harness() {
  let now = 1_000
  const lines: string[] = []
  const clock = (): number => now
  const log = new MobileClientTraceLog({
    now: clock,
    sink: (connection, line) => lines.push(`${connection} ${line}`)
  })
  const registry = new MobileClientTraceRegistry({ log, now: clock })
  return {
    registry,
    lines,
    advance: (ms: number) => {
      now += ms
    },
    connect: (connectionId = '0123456789abcdef', deviceId = 'device-1') => {
      const trace = registry.open(connectionId, 'relay')
      trace.authenticated('mobile', deviceId)
      return trace
    }
  }
}

const notStreaming = (): MobileClientMethodKind => 'unary'
const streaming = (): MobileClientMethodKind => 'streaming'
const unregistered = (): MobileClientMethodKind => undefined

afterEach(() => {
  vi.useRealTimers()
})

describe('MobileClientTraceRegistry', () => {
  it('logs auth, one first-call line per method, and the close with its code', () => {
    const h = harness()
    h.advance(5)
    const trace = h.connect()
    h.advance(20)
    h.registry.traceReply('0123456789abcdef', 'status.get', notStreaming, () => {})('{}')
    h.registry.traceReply('0123456789abcdef', 'status.get', notStreaming, () => {})('{}')
    h.registry.traceReply('0123456789abcdef', 'worktree.list', notStreaming, () => {})('{}')
    trace.markHostClose()
    h.registry.closed('0123456789abcdef', 1006)
    expect(h.lines).toEqual([
      'c:012345 connected transport=relay auth=ok +0ms',
      'c:012345 first call status.get +20ms',
      'c:012345 first call worktree.list +20ms',
      'c:012345 closed code=1006 by=host after=20ms requests=3'
    ])
  })

  it('caps first-call lines per connection', () => {
    const h = harness()
    h.connect()
    for (let i = 0; i < MOBILE_CLIENT_FIRST_CALL_LINE_CAP + 10; i++) {
      h.registry.traceReply('0123456789abcdef', `method.n${i}`, notStreaming, () => {})('{}')
    }
    const firstCalls = h.lines.filter((line) => line.includes('first call method.'))
    expect(firstCalls).toHaveLength(MOBILE_CLIENT_FIRST_CALL_LINE_CAP)
    expect(h.lines.at(-1)).toBe(
      `c:012345 first call lines capped at ${MOBILE_CLIENT_FIRST_CALL_LINE_CAP}`
    )
  })

  it('logs an unregistered method name as <unknown>, never the client string', () => {
    const h = harness()
    h.connect()
    h.registry.traceReply('0123456789abcdef', 'C:\\repo token=abc', unregistered, () => {})
    h.registry.traceReply('0123456789abcdef', '/Users/me/secret', unregistered, () => {})
    expect(h.lines.slice(1)).toEqual(['c:012345 first call <unknown> +0ms'])
  })

  it('logs methods again after a manifest read, marked, and counts requests since the bundle', () => {
    const h = harness()
    const trace = h.connect()
    const call = (method: string) =>
      h.registry.traceReply('0123456789abcdef', method, notStreaming, () => {})('{}')
    const manifest = manifestOf([{ path: 'a.js', byteLength: 10 }])
    call('status.get')
    trace.bundleManifestRead(manifest)
    call('mobileWeb.bundle.range')
    call('status.get')
    trace.bundleWindowRead(manifest, 'a.js', 0, 10)
    call('status.get')
    call('worktree.list')
    h.registry.closed('0123456789abcdef', 1000)
    expect(h.lines.filter((line) => !line.startsWith('c:012345 bundle '))).toEqual([
      'c:012345 connected transport=relay auth=ok +0ms',
      'c:012345 first call status.get +0ms',
      'c:012345 first call after bundle status.get +0ms',
      'c:012345 first call after bundle status.get +0ms',
      'c:012345 first call after bundle worktree.list +0ms',
      'c:012345 closed code=1000 by=relay after=0ms requests=5 requests_since_bundle=3'
    ])
  })

  it('attributes a clean close on a direct socket to the client', () => {
    const h = harness()
    h.registry.open('0123456789abcdef', 'direct').authenticated('mobile', 'device-1')
    h.registry.closed('0123456789abcdef', 1001)
    expect(h.lines.at(-1)).toBe('c:012345 closed code=1001 by=client after=0ms requests=0')
  })

  it('reports a request unanswered after 10s once, then its late answer', () => {
    vi.useFakeTimers()
    const h = harness()
    const trace = h.connect()
    const reply = vi.fn()
    const traced = h.registry.traceReply('0123456789abcdef', 'status.get', notStreaming, reply)
    h.advance(MOBILE_CLIENT_PENDING_REPORT_MS)
    trace.sweepPending()
    trace.sweepPending()
    h.advance(2_000)
    traced('{"ok":true}')
    traced('{"ok":true}')
    expect(reply).toHaveBeenCalledTimes(2)
    expect(h.lines.filter((line) => line.includes('status.get'))).toEqual([
      'c:012345 first call status.get +0ms',
      'c:012345 pending status.get age=10000ms',
      'c:012345 answered status.get after=12000ms'
    ])
  })

  it('never reports streaming calls as pending, and caps pending lines', () => {
    const h = harness()
    const trace = h.connect()
    h.registry.traceReply('0123456789abcdef', 'terminal.subscribe', streaming, () => {})
    for (let i = 0; i < MOBILE_CLIENT_PENDING_LINE_CAP + 3; i++) {
      h.registry.traceReply('0123456789abcdef', 'files.read', notStreaming, () => {})
    }
    h.advance(MOBILE_CLIENT_PENDING_REPORT_MS)
    trace.sweepPending()
    expect(h.lines.filter((line) => line.includes('pending terminal.subscribe'))).toEqual([])
    expect(h.lines.filter((line) => line.includes('pending files.read'))).toHaveLength(
      MOBILE_CLIENT_PENDING_LINE_CAP
    )
    h.registry.closed('0123456789abcdef', 1000)
  })

  it('writes "answered" only for a request whose pending line was written', () => {
    const h = harness()
    const trace = h.connect()
    const replies = Array.from({ length: MOBILE_CLIENT_PENDING_LINE_CAP + 1 }, () =>
      h.registry.traceReply('0123456789abcdef', 'files.read', notStreaming, () => {})
    )
    h.advance(MOBILE_CLIENT_PENDING_REPORT_MS)
    trace.sweepPending()
    for (const reply of replies) {
      reply('{}')
    }
    expect(h.lines.filter((line) => line.includes('answered files.read'))).toHaveLength(
      MOBILE_CLIENT_PENDING_LINE_CAP
    )
  })

  it('reports the manifest, first asset, and "fully served" once every asset is read', () => {
    const h = harness()
    const trace = h.connect()
    const manifest = manifestOf([
      { path: 'index.html', byteLength: 10 },
      { path: 'app.js', byteLength: 100 },
      { path: 'empty.css', byteLength: 0 }
    ])
    trace.bundleManifestRead(manifest)
    h.advance(50)
    trace.bundleWindowRead(manifest, 'app.js', 0, 64)
    trace.bundleWindowRead(manifest, 'app.js', 0, 64)
    trace.bundleWindowRead(manifest, 'index.html', 0, 10)
    trace.bundleWindowRead(manifest, 'empty.css', 0, 0)
    expect(h.lines.some((line) => line.includes('fully served'))).toBe(false)
    h.advance(50)
    trace.bundleWindowRead(manifest, 'app.js', 64, 36)
    expect(h.lines.filter((line) => line.includes('bundle'))).toEqual([
      'c:012345 bundle manifest read build=abcdef01 assets=3 bytes=110 +0ms',
      'c:012345 bundle first asset read +50ms',
      'c:012345 bundle fully served build=abcdef01 assets=3 bytes=110 download=50ms +100ms'
    ])
  })

  it('completes a download resumed on a new connection from the same device', () => {
    const h = harness()
    const manifest = manifestOf([
      { path: 'a.js', byteLength: 10 },
      { path: 'b.js', byteLength: 10 }
    ])
    h.connect('aaaaaa0000000000').bundleWindowRead(manifest, 'a.js', 0, 10)
    h.registry.closed('aaaaaa0000000000', 1006)
    h.connect('bbbbbb0000000000').bundleWindowRead(manifest, 'b.js', 0, 10)
    expect(h.lines.at(-1)).toContain('c:bbbbbb bundle fully served')
  })

  it('logs each bundle failure code once per connection', () => {
    const h = harness()
    const trace = h.connect()
    trace.bundleReadFailed('mobile_web_bundle_read_limited')
    trace.bundleReadFailed('mobile_web_bundle_read_limited')
    trace.bundleReadFailed('mobile_web_bundle_build_changed')
    expect(h.lines.filter((line) => line.includes('failed'))).toEqual([
      'c:012345 bundle read failed code=mobile_web_bundle_read_limited +0ms',
      'c:012345 bundle read failed code=mobile_web_bundle_build_changed +0ms'
    ])
  })

  it('reports an auth rejection once and skips the close line for it', () => {
    const h = harness()
    const trace = h.registry.open('fedcba9876543210', 'direct')
    h.advance(7)
    trace.hostClosing(4001, 'Unauthorized')
    h.registry.closed('fedcba9876543210', 4001)
    expect(h.lines).toEqual([
      'c:fedcba auth rejected transport=direct code=4001 reason="Unauthorized" +7ms'
    ])
  })

  it('does not trace runtime-scoped clients, even when the host later closes them', () => {
    const h = harness()
    const trace = h.registry.open('0123456789abcdef', 'direct')
    trace.authenticated('runtime', 'host-1')
    trace.hostClosing(1013, 'Outbound reply buffer overflow')
    h.registry.traceReply('0123456789abcdef', 'status.get', notStreaming, () => {})
    h.registry.closed('0123456789abcdef', 1000)
    expect(h.lines).toEqual([])
  })
})

describe('MobileClientTraceLog', () => {
  it('drops lines past the window budget and reports the count when the window rolls', () => {
    let now = 0
    const lines: string[] = []
    const log = new MobileClientTraceLog({
      now: () => now,
      sink: (connection, line) => lines.push(`${connection} ${line}`)
    })
    for (let i = 0; i < MOBILE_CLIENT_TRACE_WINDOW_LINES + 25; i++) {
      log.write('c:1', `line ${i}`)
    }
    log.write('c:1', 'bundle line', { unbudgeted: true })
    expect(lines).toHaveLength(MOBILE_CLIENT_TRACE_WINDOW_LINES + 2)
    expect(lines.at(-2)).toBe('- rate limit reached; dropping lines until the window ends')
    expect(lines.at(-1)).toBe('c:1 bundle line')
    now += MOBILE_CLIENT_TRACE_WINDOW_MS
    log.write('c:2', 'next')
    expect(lines.slice(-2)).toEqual([
      '- rate limit dropped 25 lines in the previous window',
      'c:2 next'
    ])
  })

  it('swallows a throwing sink', () => {
    const log = new MobileClientTraceLog({
      sink: () => {
        throw new Error('disk full')
      }
    })
    expect(() => log.write('c:1', 'line')).not.toThrow()
  })
})
