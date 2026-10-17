/**
 * A sparse per-connection trace of each paired mobile client, written to the desktop's log so one
 * attempt shows how far a phone got: auth, the OTA page download, which RPC methods arrived and
 * when, requests left unanswered, and how the socket closed (STA-10545).
 *
 * Method names and codes only: never params, payloads, paths, worktree ids, tokens, or keys.
 */
import type { MobileWebBundleManifest } from '../../../shared/mobile-web-bundle/manifest-contract'
import { MobileClientTraceLog } from './mobile-client-trace-log'
import {
  MobileWebBundleServeProgress,
  mobileWebBundleTotalBytes
} from './mobile-web-bundle-serve-progress'

export const MOBILE_CLIENT_FIRST_CALL_LINE_CAP = 40
export const MOBILE_CLIENT_PENDING_LINE_CAP = 5
export const MOBILE_CLIENT_PENDING_REPORT_MS = 10_000
const PENDING_SWEEP_MS = 2_000
const BUNDLE_METHOD_PREFIX = 'mobileWeb.bundle.'

/** How the dispatcher registry knows a method; `undefined` when it is not a registered method. */
export type MobileClientMethodKind = 'unary' | 'streaming' | undefined

type PendingRequest = {
  method: string
  startedAt: number
  report: 'none' | 'written' | 'suppressed'
}

function closeInitiator(
  code: number | undefined,
  hostClosed: boolean,
  transport: 'direct' | 'relay'
): string {
  if (hostClosed) {
    return 'host'
  }
  // 1006: no close frame, so a dropped network or a host heartbeat reap; neither side said goodbye.
  if (code === undefined || code === 1006) {
    return 'abnormal'
  }
  // Why: a relay socket's close frame comes from the relay cell, which may or may not echo the phone.
  return transport === 'relay' ? 'relay' : 'client'
}

export class MobileClientConnectionTrace {
  readonly tag: string
  private readonly openedAt: number
  // 'discarded': not a phone; a later host close must not read as an auth verdict.
  private state: 'handshake' | 'authenticated' | 'rejected' | 'discarded' = 'handshake'
  private deviceKey: string | null = null
  private hostClosed = false
  private requestCount = 0
  // Non-bundle requests since the last manifest read; null until a manifest is read.
  private requestsSinceBundle: number | null = null
  private readonly calledMethods = new Set<string>()
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 0
  private pendingLines = 0
  private pendingSweep: ReturnType<typeof setInterval> | null = null
  private readonly bundleFailureCodes = new Set<string>()

  constructor(
    connectionId: string,
    private readonly transport: 'direct' | 'relay',
    private readonly deps: {
      log: MobileClientTraceLog
      bundles: MobileWebBundleServeProgress
      now: () => number
      discard: () => void
    }
  ) {
    this.tag = `c:${connectionId.slice(0, 6)}`
    this.openedAt = deps.now()
  }

  private sinceOpen(): number {
    return this.deps.now() - this.openedAt
  }

  private write(line: string, options?: { unbudgeted?: boolean }): void {
    this.deps.log.write(this.tag, line, options)
  }

  /** Only paired phones are traced; a runtime-scoped client is another Orca host. */
  authenticated(scope: string, deviceId: string): void {
    if (scope !== 'mobile') {
      this.state = 'discarded'
      this.deps.discard()
      return
    }
    this.state = 'authenticated'
    this.deviceKey = deviceId
    this.write(`connected transport=${this.transport} auth=ok +${this.sinceOpen()}ms`)
  }

  /** The host is closing the socket itself; before auth that is the auth verdict. */
  hostClosing(code: number, reason: string): void {
    this.hostClosed = true
    if (this.state === 'handshake') {
      this.state = 'rejected'
      this.write(
        `auth rejected transport=${this.transport} code=${code} reason="${reason}" +${this.sinceOpen()}ms`
      )
      return
    }
    if (this.state === 'authenticated') {
      this.write(`host closing code=${code} reason="${reason}"`)
    }
  }

  /** A revoke or other host-side terminate that does not pass through `hostClosing`. */
  markHostClose(): void {
    this.hostClosed = true
  }

  closed(code: number | undefined): void {
    this.stopPendingSweep()
    const codeText = code === undefined ? 'none' : String(code)
    if (this.state === 'handshake') {
      this.write(`closed before auth code=${codeText} after=${this.sinceOpen()}ms`)
    } else if (this.state === 'authenticated') {
      this.write(
        `closed code=${codeText} by=${closeInitiator(code, this.hostClosed, this.transport)} after=${this.sinceOpen()}ms requests=${this.requestCount}${this.requestsSinceBundle === null ? '' : ` requests_since_bundle=${this.requestsSinceBundle}`}`
      )
    }
  }

  /** Returns the callback that marks this request answered; call it on the first reply. */
  beginRequest(method: string, kind: MobileClientMethodKind): () => void {
    if (this.state !== 'authenticated') {
      return () => {}
    }
    this.requestCount += 1
    // Why: the method string is client-supplied; only registered names may reach the log.
    const name = kind === undefined ? '<unknown>' : method
    const isBundleMethod = name.startsWith(BUNDLE_METHOD_PREFIX)
    if (!isBundleMethod) {
      if (this.requestsSinceBundle !== null) {
        this.requestsSinceBundle += 1
      }
      this.noteFirstCall(name)
    }
    // Why: a streaming call legitimately stays open with no reply until an event arrives.
    if (kind === 'streaming') {
      return () => {}
    }
    const id = ++this.nextRequestId
    this.pending.set(id, { method: name, startedAt: this.deps.now(), report: 'none' })
    this.ensurePendingSweep()
    return () => this.settle(id)
  }

  private noteFirstCall(method: string): void {
    if (this.calledMethods.has(method)) {
      return
    }
    // Why stop tracking: client-chosen names must not grow this set without bound.
    if (this.calledMethods.size >= MOBILE_CLIENT_FIRST_CALL_LINE_CAP) {
      return
    }
    this.calledMethods.add(method)
    const phase = this.requestsSinceBundle === null ? '' : 'after bundle '
    this.write(`first call ${phase}${method} +${this.sinceOpen()}ms`)
    if (this.calledMethods.size === MOBILE_CLIENT_FIRST_CALL_LINE_CAP) {
      this.write(`first call lines capped at ${MOBILE_CLIENT_FIRST_CALL_LINE_CAP}`)
    }
  }

  private settle(id: number): void {
    const request = this.pending.get(id)
    if (!request) {
      return
    }
    this.pending.delete(id)
    if (request.report === 'written') {
      this.write(`answered ${request.method} after=${this.deps.now() - request.startedAt}ms`)
    }
    if (this.pending.size === 0) {
      this.stopPendingSweep()
    }
  }

  private ensurePendingSweep(): void {
    if (this.pendingSweep) {
      return
    }
    this.pendingSweep = setInterval(() => this.sweepPending(), PENDING_SWEEP_MS)
    // Why: bookkeeping must never hold the process open.
    this.pendingSweep.unref?.()
  }

  private stopPendingSweep(): void {
    if (this.pendingSweep) {
      clearInterval(this.pendingSweep)
      this.pendingSweep = null
    }
  }

  /** Exposed for tests; the interval calls it in the app. */
  sweepPending(): void {
    const now = this.deps.now()
    for (const request of this.pending.values()) {
      if (request.report !== 'none' || now - request.startedAt < MOBILE_CLIENT_PENDING_REPORT_MS) {
        continue
      }
      if (this.pendingLines >= MOBILE_CLIENT_PENDING_LINE_CAP) {
        request.report = 'suppressed'
        continue
      }
      request.report = 'written'
      this.pendingLines += 1
      this.write(`pending ${request.method} age=${now - request.startedAt}ms`)
    }
  }

  /** Why reset: page and native calls share one wire, so methods the native screens already called
   *  must log again once the page could be running. */
  private startBundlePhase(): void {
    this.calledMethods.clear()
  }

  bundleManifestRead(manifest: MobileWebBundleManifest): void {
    this.startBundlePhase()
    this.requestsSinceBundle = 0
    this.write(
      `bundle manifest read build=${manifest.buildId.slice(0, 8)} assets=${manifest.assets.length} bytes=${mobileWebBundleTotalBytes(manifest)} +${this.sinceOpen()}ms`,
      { unbudgeted: true }
    )
  }

  bundleWindowRead(
    manifest: MobileWebBundleManifest,
    path: string,
    offset: number,
    byteLength: number
  ): void {
    if (this.deviceKey === null) {
      return
    }
    const verdict = this.deps.bundles.windowServed(
      this.deviceKey,
      manifest,
      path,
      offset,
      byteLength
    )
    if (verdict.started) {
      this.write(`bundle first asset read +${this.sinceOpen()}ms`, { unbudgeted: true })
    }
    if (verdict.fullyServed) {
      this.startBundlePhase()
      this.write(
        `bundle fully served build=${manifest.buildId.slice(0, 8)} assets=${manifest.assets.length} bytes=${mobileWebBundleTotalBytes(manifest)} download=${verdict.elapsedMs}ms +${this.sinceOpen()}ms`,
        { unbudgeted: true }
      )
    }
  }

  /** Once per code per connection: a failing retry loop must not repeat the line. */
  bundleReadFailed(code: string): void {
    if (this.bundleFailureCodes.has(code)) {
      return
    }
    this.bundleFailureCodes.add(code)
    this.write(`bundle read failed code=${code} +${this.sinceOpen()}ms`)
  }
}

/** Every live mobile connection's trace, keyed by the wiring's connection id. */
export class MobileClientTraceRegistry {
  private readonly connections = new Map<string, MobileClientConnectionTrace>()
  private readonly log: MobileClientTraceLog
  private readonly bundles: MobileWebBundleServeProgress
  private readonly now: () => number

  constructor(options: { log?: MobileClientTraceLog; now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? new MobileClientTraceLog({ now: this.now })
    this.bundles = new MobileWebBundleServeProgress(this.now)
  }

  open(connectionId: string, transport: 'direct' | 'relay'): MobileClientConnectionTrace {
    const trace = new MobileClientConnectionTrace(connectionId, transport, {
      log: this.log,
      bundles: this.bundles,
      now: this.now,
      discard: () => this.connections.delete(connectionId)
    })
    this.connections.set(connectionId, trace)
    return trace
  }

  forConnection(connectionId: string | undefined): MobileClientConnectionTrace | undefined {
    return connectionId === undefined ? undefined : this.connections.get(connectionId)
  }

  closed(connectionId: string | undefined, code: number | undefined): void {
    if (connectionId === undefined) {
      return
    }
    this.connections.get(connectionId)?.closed(code)
    this.connections.delete(connectionId)
  }

  /** Wraps `reply` so the first response settles the request's pending timer. */
  traceReply(
    connectionId: string | undefined,
    method: string,
    methodKind: (method: string) => MobileClientMethodKind,
    reply: (response: string) => void
  ): (response: string) => void {
    const trace = this.forConnection(connectionId)
    if (!trace) {
      return reply
    }
    const settle = trace.beginRequest(method, methodKind(method))
    return (response) => {
      settle()
      reply(response)
    }
  }
}

/** Process-wide so the bundle handlers, which see only an RpcContext, reach the same traces. */
export const mobileClientTraces = new MobileClientTraceRegistry()
