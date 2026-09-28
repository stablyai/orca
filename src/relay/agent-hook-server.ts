import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  type HookListenerState
} from '../shared/agent-hook-listener/listener-state'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../shared/agent-hook-listener/endpoint-publication'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference,
  isHookRequestTruncatedError
} from '../shared/agent-hook-transport-interference'
import {
  REMOTE_AGENT_HOOK_ENV,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { openAgentHookInbox, type AgentHookInbox } from '../shared/agent-hook-inbox'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope, hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { MAX_CACHED_PANES, selectReplayableCachedPanes } from './agent-hook-cached-pane-status'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  /** Env tag forwarded into hook payloads. Defaults to "remote", which main excludes from dev-vs-prod mismatch warnings. */
  env?: string
  /** Fixed auth token. WSL relay passes the host-issued token (already in guest env via WSLENV) so unmodified hook clients authenticate. Defaults to a fresh UUID. */
  token?: string
  /** Preferred bind port. WSL relay passes the Windows listener's port so env-sourced client coords stay truthful; falls back to :0 if occupied. Defaults to :0. */
  preferredPort?: number
  forward: RelayHookForward
  /**
   * True when the host has been told this pane's tab is gone and no PTY has re-bound the paneKey.
   * Posts from such a pane come from a process the user already closed, so they describe no surface
   * any client owns. Defaults to "never retired", which is the pre-existing behaviour — a listener
   * with no PTY handler behind it (the WSL relay) keeps forwarding everything.
   */
  isPaneSurfaceRetired?: (paneKey: string) => boolean
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
  /**
   * Whether hook scripts may commit to this relay's inbox instead of POSTing. Only safe when the
   * panes' output flows through this relay, which drains before publishing it; defaults to true.
   */
  hookInbox?: boolean
}

export class RelayAgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  private env: string
  private endpointDir: string
  private endpointFilePath: string
  private endpointFileWritten = false
  private state: HookListenerState = createHookListenerState()
  private transportInterference = createHookTransportInterferenceTracker((report) => {
    process.stderr.write(`${describeHookTransportInterference(report)}\n`)
  })
  // Why: retain envelope metadata so replays match live POSTs.
  // Invariant: keys mirror state.lastStatusByPaneKey, populated/cleared in lockstep.
  private lastEnvelopeMetaByPaneKey = new Map<
    string,
    { source: AgentHookSource; env?: string; version?: string }
  >()
  private forward: RelayHookForward
  private isPaneSurfaceRetired: (paneKey: string) => boolean
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private retryScheduler: AgentHookResultRetryScheduler
  private hookInbox: AgentHookInbox | null = null

  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.isPaneSurfaceRetired = options.isPaneSurfaceRetired ?? (() => false)
    this.retryScheduler = new AgentHookResultRetryScheduler({
      state: this.state,
      env: this.env,
      isListening: () => this.server !== null,
      applyEvent: (event, source, env, version) => {
        this.applyEvent(event, source, env, version)
      }
    })
  }

  async start(options: RelayHookServerStartOptions = {}): Promise<void> {
    if (this.server) {
      return
    }
    this.token = this.fixedToken ?? randomUUID()
    this.endpointFileWritten = false
    this.portFallbackApplied = false
    this.hookInbox ??= openAgentHookInbox({
      endpointDir: this.endpointDir,
      ingest: (source, body, { isReplay }) => this.ingestHookBody(source, body, { isReplay }),
      inbox: options.hookInbox
    })
    try {
      await this.listenOn(this.preferredPort)
    } catch (err) {
      // Why: fall back to an ephemeral port on EADDRINUSE; clients use the endpoint file.
      if (this.preferredPort > 0 && (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        this.portFallbackApplied = true
        await this.listenOn(0)
      } else {
        throw err
      }
    }
    if (options.publishEndpoint !== false) {
      this.publishEndpointFile()
    }
  }

  get usedPortFallback(): boolean {
    return this.portFallbackApplied
  }

  private listenOn(port: number): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    return new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        // Why: clear failed server refs so later start() calls can retry.
        this.server = null
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          process.stderr.write(`[relay-hook-server] server error: ${err.message}\n`)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      }
      this.server!.once('error', onStartupError)
      // Why: loopback only — reachable by the in-box agent CLI (127.0.0.1), not from outside the box.
      this.server!.listen(port, '127.0.0.1', onListening)
    })
  }

  publishEndpointFile(): boolean {
    if (this.port <= 0 || !this.token) {
      this.endpointFileWritten = false
      return false
    }
    this.endpointFileWritten = writeEndpointFile(this.endpointDir, this.endpointFilePath, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT,
      inbox: this.hookInbox !== null
    })
    return this.endpointFileWritten
  }

  stop(): void {
    // Why first: a record claimed after forwarding is torn down would be lost, not left for the
    // next relay.
    this.hookInbox?.close()
    this.hookInbox = null
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    this.retryScheduler.clearAll()
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
  }

  /** Applies and forwards every hook event already committed to the inbox. */
  drainCommittedHooks(): void {
    this.hookInbox?.drain()
  }

  /** Request-driven replay: re-forwards each cached paneKey payload as a fresh notification. Forwards are
   *  issued before the request handler returns, so the response trails all replayed notifications. */
  replayCachedPayloadsForPanes(): number {
    this.drainCommittedHooks()
    const cachedSnapshot = new Map(this.state.lastStatusByPaneKey)
    const replayable = selectReplayableCachedPanes({
      cachedByPaneKey: cachedSnapshot,
      metaByPaneKey: this.lastEnvelopeMetaByPaneKey,
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      dropPane: (paneKey) => this.clearPaneState(paneKey)
    })
    for (const { event, meta } of replayable) {
      this.forward(
        buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, { isReplay: true })
      )
    }
    return replayable.length
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane can't resurface as a ghost event on reconnect. */
  clearPaneState(paneKey: string): void {
    this.retryScheduler.clearAssistantMessageRetry(paneKey)
    this.retryScheduler.clearTranscriptPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
  }

  /** Env vars to inject into relay-spawned PTYs so the hook script/plugin POSTs back to this loopback server. */
  buildPtyEnv(): Record<string, string> {
    return buildRelayHookPtyEnv({
      port: this.port,
      token: this.token,
      env: this.env,
      endpointFilePath: this.endpointFilePath,
      endpointFileWritten: this.endpointFileWritten
    })
  }

  /** Test-only / diagnostics accessor. */
  getCoordinates(): { port: number; token: string; endpointFilePath: string } {
    return { port: this.port, token: this.token, endpointFilePath: this.endpointFilePath }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.headers['x-orca-agent-hook-token'] !== this.token) {
      res.writeHead(403)
      res.end()
      return
    }
    // Why: track our own destroy so the slowloris cap can't be misread as outside interference.
    let destroyedBySlowlorisCap = false
    req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
      destroyedBySlowlorisCap = true
      req.destroy()
    })
    try {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const source = resolveHookSource(pathname)
      if (!source) {
        res.writeHead(404)
        res.end()
        return
      }
      const body = await readRequestBody(req)
      // Why: anything committed to the inbox before this POST was published earlier.
      this.drainCommittedHooks()
      this.ingestHookBody(source, mergeAgentHookRequestHeaders(body, req.headers))
      res.writeHead(204)
      res.end()
    } catch (err) {
      // Why (#11217): a remote host can run the same IDS; count truncations here so a blocked SSH
      // relay reports the cause instead of an anonymous "hook request failed".
      if (isHookRequestTruncatedError(err) && !destroyedBySlowlorisCap) {
        this.transportInterference.record({ source: null, error: err })
      }
      // Why: hooks fail open (204 on any error) so a buggy agent never blocks the run; still log so the 204 doesn't mask bugs.
      process.stderr.write(
        `[relay-hook-server] hook request failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
      res.writeHead(204)
      res.end()
    }
  }

  /** The one ingest path for a hook body, whichever transport carried it. A replay was committed
   *  while no relay was running: it only refreshes the per-pane cache, which the client pulls with
   *  its replay request once it is actually listening. */
  private ingestHookBody(
    source: AgentHookSource,
    hookBody: unknown,
    options: { isReplay?: boolean } = {}
  ): void {
    const event = normalizeHookPayload(this.state, source, hookBody, this.env, {
      deferCompactOwnershipToClient: true
    })
    if (!event) {
      return
    }
    // TODO: once normalizeHookPayload returns validated env/version, drop bodyEnv/bodyVersion and source them from the listener result.
    const env = hookBodyEnv(hookBody)
    const version = hookBodyVersion(hookBody)
    if (options.isReplay) {
      this.applyEvent(event, source, env, version, { isReplay: true, forward: false })
      return
    }
    this.applyEvent(event, source, env, version)
    this.retryScheduler.scheduleAssistantMessageRetry(source, hookBody, event, env, version)
    this.retryScheduler.scheduleTranscriptPoll(source, hookBody, event, env, version)
  }

  private applyEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean; forward?: boolean } = {}
  ): void {
    // Why: this post came from a process still running inside a pane whose tab the user closed.
    // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
    // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
    // transcript the orphan is still writing (#12447). Drop the stale cache with it.
    if (this.isPaneSurfaceRetired(event.paneKey)) {
      this.clearPaneState(event.paneKey)
      return
    }
    if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
      this.retryScheduler.clearAssistantMessageRetry(event.paneKey)
    }
    // Why: keep PostCompact identity in the replay cache so the client can re-run ownership when
    // it reconnects. Stripping it would let a cold relay replay a completion as an ordinary `done`
    // row and resurrect a pane that the client had already retired.
    if (
      !cacheRelayLegacyAgentStatus(this.state, event, MAX_CACHED_PANES, (paneKey) =>
        this.clearPaneState(paneKey)
      )
    ) {
      return
    }
    this.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
    if (options.forward !== false) {
      this.forward(
        buildRelayHookEnvelope(event, source, env, version, { isReplay: options.isReplay })
      )
    }
  }
}
