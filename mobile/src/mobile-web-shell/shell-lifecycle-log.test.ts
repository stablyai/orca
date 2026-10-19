import { describe, expect, it, vi } from 'vitest'
import { buildConnectionDiagnosticsReport } from '../diagnostics/connection-diagnostics-report'
import type { ConnectionLogEntry } from '../transport/types'
import {
  CACHED,
  MANIFEST,
  createMobileWebShellSession,
  gates,
  ROUTE,
  stamp
} from './mobile-web-shell-session-test-fixtures'
import { reduceMobileWebShellSession } from './mobile-web-shell-session'
import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
import { bridgeDiagnosticLine, frameWithoutHostLine } from './shell-bridge-log-lines'
import { recordShellLifecycleLine, type ShellLifecycleLine } from './shell-lifecycle-line-recorder'
import {
  EMPTY_SHELL_LOG_TRACE,
  pageFaultLine,
  shellSessionStepLines,
  shellStallLine,
  traceShellStep,
  type ShellLogTrace
} from './shell-lifecycle-log'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

type Pending = Parameters<typeof stamp>[1]

/** Replays events through the real reducer, collecting what each step would log. */
type Replayed = {
  session: MobileWebShellSession
  trace: ShellLogTrace
  lines: ShellLifecycleLine[]
}

function replay(
  events: readonly Pending[],
  from: Omit<Replayed, 'lines'> = {
    session: createMobileWebShellSession(ROUTE),
    trace: EMPTY_SHELL_LOG_TRACE
  }
): Replayed {
  let { session, trace } = from
  const lines: ShellLifecycleLine[] = []
  for (const pending of events) {
    const event: MobileWebShellSessionEvent = stamp(session.flow, pending)
    const next = reduceMobileWebShellSession(session, event).session
    trace = traceShellStep(trace, session, event, next)
    lines.push(...shellSessionStepLines(session, event, next, trace))
    session = next
  }
  return { session, trace, lines }
}

function stall(replayed: Omit<Replayed, 'lines'>): ShellLifecycleLine | null {
  return shellStallLine(replayed.session.state, replayed.session, replayed.trace)
}

const ACTIVATED = {
  type: 'activated',
  generationDirectory: '/Users/someone/Library/Caches/gen-1',
  sessionId: 'session-one',
  buildId: MANIFEST.buildId,
  totalBytes: MANIFEST.totalBytes,
  elapsedMs: 1234
} as const

const DOWNLOAD_OPEN: readonly Pending[] = [
  { type: 'gates-changed', gates: gates() },
  { type: 'cache-read', generation: null },
  { type: 'manifest-read', manifest: MANIFEST },
  {
    type: 'fetch-progress',
    completedAssets: 1,
    totalAssets: MANIFEST.totalAssets,
    receivedBytes: 10,
    totalBytes: MANIFEST.totalBytes
  },
  {
    type: 'fetch-progress',
    completedAssets: 2,
    totalAssets: MANIFEST.totalAssets,
    receivedBytes: 20,
    totalBytes: MANIFEST.totalBytes
  },
  { type: 'download-staged' },
  ACTIVATED
]

function present(line: ShellLifecycleLine | null): ShellLifecycleLine[] {
  expect(line).not.toBeNull()
  return line === null ? [] : [line]
}

function summary(lines: readonly ShellLifecycleLine[]): string[] {
  return lines.map(
    (line) => `${line.code} ${line.message}${line.detail ? ` | ${line.detail}` : ''}`
  )
}

const PAGE_LOAD: readonly Pending[] = [
  { type: 'document-started' },
  { type: 'document-loaded' },
  { type: 'page-ready' }
]

const BUILD = MANIFEST.buildId.slice(0, 8)

describe('shell lifecycle log lines', () => {
  it('writes exactly one line for a healthy cached open: the paint', () => {
    const { lines } = replay([
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: CACHED },
      { type: 'manifest-read', manifest: MANIFEST },
      ACTIVATED,
      ...PAGE_LOAD,
      { type: 'page-ready' },
      { type: 'page-painted' },
      { type: 'page-painted' },
      { type: 'page-back-claim', claimed: true }
    ])
    expect(summary(lines)).toEqual([
      `web-shell-page Web shell: page painted | source=cache build=${BUILD} activatedMs=1234`
    ])
  })

  it('adds only the download milestones to a downloading open, and no progress ticks', () => {
    const { lines } = replay([...DOWNLOAD_OPEN, ...PAGE_LOAD, { type: 'page-painted' }])
    expect(summary(lines)).toEqual([
      `web-shell-flow Web shell: downloading app | ${MANIFEST.totalAssets} assets, ${MANIFEST.totalBytes} bytes`,
      'web-shell-flow Web shell: activating app | source=download',
      `web-shell-page Web shell: page painted | source=download build=${BUILD} activatedMs=1234`
    ])
    // The generation directory names a device path and never reaches the log.
    expect(JSON.stringify(lines)).not.toContain('/Users/someone')
  })

  it('logs the wall a host with no page earns', () => {
    const { session, lines } = replay([
      { type: 'gates-changed', gates: gates({ hostCapabilities: [] }) }
    ])
    expect(session.state.kind).toBe('wall')
    expect(summary(lines)).toEqual([
      'web-shell-flow Web shell: blocked by version check | reason=bundle-unavailable'
    ])
  })

  it('logs a missed ready deadline, the failure it causes and the recovery flow', () => {
    const opened = replay(DOWNLOAD_OPEN)
    const { lines } = replay([{ type: 'document-loaded' }, { type: 'page-ready-deadline' }], opened)
    expect(summary(lines)).toEqual([
      'web-shell-page Web shell: page never said ready before the deadline',
      'web-shell-flow Web shell: checking host'
    ])
  })

  it('logs a document that never finished loading, and the recovery flow', () => {
    const opened = replay(DOWNLOAD_OPEN)
    const { lines } = replay(
      [{ type: 'document-started' }, { type: 'document-load-deadline' }],
      opened
    )
    expect(summary(lines)).toEqual([
      'web-shell-page Web shell: document never finished loading before the deadline',
      'web-shell-flow Web shell: checking host'
    ])
  })

  it('logs a view failure but not the remount it earns', () => {
    const opened = replay(DOWNLOAD_OPEN)
    const { lines } = replay(
      [
        { type: 'shell-failed', reason: 'render-process-gone' },
        { type: 'remounted', sessionId: 'session-two' }
      ],
      opened
    )
    expect(summary(lines)).toEqual([
      'web-shell-page Web shell: page load failed | reason=render-process-gone'
    ])
  })

  it('ignores results from a superseded flow', () => {
    const opened = replay(DOWNLOAD_OPEN)
    const { lines } = replay(
      [
        { type: 'page-ready-deadline', flow: opened.session.flow - 1 },
        { ...ACTIVATED, flow: 0 }
      ],
      opened
    )
    expect(lines).toEqual([])
  })

  it('logs a failed download with its closed reason code', () => {
    const { lines } = replay([
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null },
      { type: 'download-failed', cause: { reason: 'connection-lost', hostCode: null } }
    ])
    expect(summary(lines)).toEqual([
      'web-shell-flow Web shell: app download failed | reason=connection-lost',
      'web-shell-flow Web shell: failed | reason=download-failed retried=no'
    ])
  })
})

describe('shell stall lines', () => {
  it('names what a checking session waits on: the gates, then the cache', () => {
    const fresh = replay([])
    expect(stall(fresh)).toMatchObject({
      code: 'web-shell-stalled',
      message: 'Web shell: still checking host after 15s',
      detail: 'gates=none cache=unread'
    })
    expect(
      stall(replay([{ type: 'gates-changed', gates: gates({ reachability: 'connecting' }) }]))
    ).toMatchObject({ detail: 'gates=dialling cache=unread' })
    const opened = replay([{ type: 'gates-changed', gates: gates() }])
    expect(opened.session.state.kind).toBe('checking')
    expect(stall(opened)).toMatchObject({ detail: 'gates=open cache=unread' })
    // An empty cache leaves `cached` null, so only the trace can tell the manifest wait apart.
    const awaitingManifest = replay([{ type: 'cache-read', generation: null }], opened)
    expect(stall(awaitingManifest)).toMatchObject({ detail: 'gates=open cache=read' })
  })

  it('names how far a stalled download got', () => {
    const fetching = replay(DOWNLOAD_OPEN.slice(0, 4))
    expect(stall(fetching)).toMatchObject({
      message: 'Web shell: download made no progress for 15s',
      detail: `assets=1/${MANIFEST.totalAssets} bytes=10/${MANIFEST.totalBytes}`
    })
  })

  it('names an activation that never finished', () => {
    expect(stall(replay(DOWNLOAD_OPEN.slice(0, 6)))).toMatchObject({
      message: 'Web shell: still activating after 15s',
      detail: 'source=download'
    })
  })

  it('tells a page that keeps refusing init from one that took it and never drew', () => {
    const opened = replay(DOWNLOAD_OPEN)
    expect(stall(opened)).toMatchObject({
      message: 'Web shell: page has not drawn after 15s',
      detail: `build=${BUILD} page ready=no readyAsks=0 documentLoaded=no`
    })
    const refusing = replay([...PAGE_LOAD, { type: 'page-ready' }, { type: 'page-ready' }], opened)
    expect(stall(refusing)).toMatchObject({
      detail: `build=${BUILD} page ready=yes readyAsks=3 documentLoaded=yes`
    })
    // A replacement document starts its own count.
    const reloaded = replay([{ type: 'document-started' }, { type: 'page-ready' }], refusing)
    expect(stall(reloaded)).toMatchObject({
      detail: `build=${BUILD} page ready=yes readyAsks=1 documentLoaded=no`
    })
    expect(stall(replay([{ type: 'page-painted' }], reloaded))).toBeNull()
  })

  it('stays quiet for states nobody waits in', () => {
    expect(
      stall(replay([{ type: 'gates-changed', gates: gates({ hostCapabilities: [] }) }]))
    ).toBeNull()
  })
})

describe('shell failure details', () => {
  it('keeps device paths out of a page fault', () => {
    expect(
      pageFaultLine({
        category: 'TypeError',
        message: 'x is undefined at file:///var/mobile/app/index.js:1\n    at /Users/me/secret.js',
        isRpcDeliveryUnknown: false
      }).detail
    ).toBe('TypeError: x is undefined at [path]')
  })
})

describe('recording shell lines', () => {
  it('writes a flapping host line once until a different shell line is written', () => {
    const host = 'flapping-host'
    const checking = replay([
      { type: 'gates-changed', gates: gates({ reachability: 'unreachable' }) },
      { type: 'cache-read', generation: null },
      { type: 'gates-changed', gates: gates({ reachability: 'connecting' }) }
    ]).lines
    expect(summary(checking)).toEqual([
      'web-shell-flow Web shell: host unreachable and no app cached',
      'web-shell-flow Web shell: checking host'
    ])
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (const line of checking) {
        recordShellLifecycleLine(host, line)
      }
    }
    const messages = () => connectionLogStore.get(host).map((entry) => entry.message)
    expect(messages()).toEqual([
      'Web shell: host unreachable and no app cached',
      'Web shell: checking host'
    ])
    recordShellLifecycleLine(host, frameWithoutHostLine({ clientReady: true, snapshotReady: true }))
    recordShellLifecycleLine(host, checking[1]!)
    recordShellLifecycleLine('other-host', checking[1]!)
    expect(messages().slice(2)).toEqual([
      'Web shell: page frame with no bridge host',
      'Web shell: checking host'
    ])
    expect(connectionLogStore.get('other-host')).toHaveLength(1)
  })
})

describe('shell lifecycle lines in the exported report', () => {
  function entries(lines: readonly ShellLifecycleLine[]): ConnectionLogEntry[] {
    return lines.map((line, index) => ({ id: `e${index}`, ts: 1_000 + index * 1_000, ...line }))
  }

  it('shows where a connected session stalled without changing the connection verdict', () => {
    const opened = replay(DOWNLOAD_OPEN)
    const page = replay(PAGE_LOAD, opened)
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Desk',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'connected',
      reconnectAttempts: 0,
      lastConnectedAt: 500,
      platform: 'ios',
      appVersion: '0.0.56',
      bridgeProtocolVersion: 1,
      entries: entries([...opened.lines, ...page.lines, ...present(stall(page))]),
      nowMs: 60_000
    })
    expect(report).toContain('Bridge protocol: 1')
    expect(report).toContain('Likely cause: Connection is healthy.')
    expect(report).toContain('[web-shell-flow] Web shell: activating app')
    expect(report).toContain(
      `[warn] [web-shell-stalled] Web shell: page has not drawn after 15s — build=${BUILD} page ready=yes readyAsks=1 documentLoaded=yes`
    )
  })

  it('never reads shell lines as a connection failure', () => {
    const failed = replay([
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null },
      { type: 'download-failed', cause: { reason: 'connection-lost', hostCode: null } }
    ])
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Desk',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'disconnected',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      platform: 'ios',
      appVersion: '0.0.56',
      bridgeProtocolVersion: 1,
      entries: entries([
        ...failed.lines,
        ...present(stall(replay(DOWNLOAD_OPEN.slice(0, 6)))),
        ...present(stall(replay([]))),
        ...present(bridgeDiagnosticLine({ kind: 'refused', refusal: 'oversized' })),
        frameWithoutHostLine({ clientReady: false, snapshotReady: false })
      ]),
      nowMs: 60_000
    })
    expect(report).toContain(
      'Likely cause: No single failure cause can be determined from the recorded events.'
    )
  })

  it('leaves an earlier connection failure as the likely cause', () => {
    const timeout: ConnectionLogEntry = {
      id: 'timeout',
      ts: 500,
      level: 'error',
      code: 'connect-timeout',
      message: 'WebSocket connect timeout'
    }
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Desk',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'disconnected',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      platform: 'ios',
      appVersion: '0.0.56',
      bridgeProtocolVersion: 1,
      entries: [timeout, ...entries(replay(DOWNLOAD_OPEN).lines)],
      nowMs: 60_000
    })
    expect(report).toContain(
      'Likely cause: The saved direct endpoint did not answer before the connection timeout.'
    )
  })
})
