import { RelayAgentHookCanonicalStatus } from './agent-hook-canonical-status'
import type {
  RelayHookForward,
  RelayHookServerOptions,
  RelayHookServerStartOptions
} from './agent-hook-server-contract'
export type {
  RelayHookForward,
  RelayHookServerOptions,
  RelayHookServerStartOptions
} from './agent-hook-server-contract'
import { handleRelayHookRequest } from './agent-hook-request'
import { transitionHookPresence } from '../shared/agent-hook-presence-transition'
import { RelayAgentPresence } from './relay-agent-presence'
import { isSameAgentProcess } from '../shared/agent-process-presence'
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
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference
} from '../shared/agent-hook-transport-interference'
import { REMOTE_AGENT_HOOK_ENV, type AgentHookSource } from '../shared/agent-hook-relay'
import type { SpoolRecord } from '../shared/agent-hook-spool'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import { drainRelayHookSpool, ingestRelayHookSpoolRecord } from './agent-hook-spool-ingest'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { MAX_CACHED_PANES, selectReplayableCachedPanes } from './agent-hook-cached-pane-status'

export class RelayAgentHookServer extends RelayAgentHookCanonicalStatus {
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
  private getAgentLaunchToken: (paneKey: string) => string | undefined
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private readonly presenceChecks = new RelayAgentPresence()
  private retryScheduler: AgentHookResultRetryScheduler

  constructor(options: RelayHookServerOptions) {
    super()
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.isPaneSurfaceRetired = options.isPaneSurfaceRetired ?? (() => false)
    this.getAgentLaunchToken = options.getAgentLaunchToken ?? (() => undefined)
    this.configureCanonicalHooks(
      options,
      (paneKey) => this.clearPaneState(paneKey, true),
      (paneKey) => {
        const row = this.state.lastStatusByPaneKey.get(paneKey)
        return row
          ? { ...row, source: this.lastEnvelopeMetaByPaneKey.get(paneKey)?.source ?? row.source }
          : undefined
      }
    )
    this.retryScheduler = new AgentHookResultRetryScheduler({
      state: this.state,
      env: this.env,
      isListening: () => this.server !== null,
      applyEvent: (event, source, env, version) => {
        this.applyEvent(event, source, env, version, { checkPresence: false })
      }
    })
  }

  async start(options: RelayHookServerStartOptions = {}): Promise<void> {
    if (this.server) {
      return
    }
    this.startCanonicalHooks()
    this.token = this.fixedToken ?? randomUUID()
    this.endpointFileWritten = false
    this.portFallbackApplied = false
    drainRelayHookSpool(this.endpointDir, (record) => this.ingestSpoolRecord(record))
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
      openCodeTui: true,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    return this.endpointFileWritten
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    this.stopCanonicalHooks()
    this.retryScheduler.clearAll()
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
  }

  /** Request-driven replay: re-forwards each cached paneKey payload as a fresh notification. Forwards are
   *  issued before the request handler returns, so the response trails all replayed notifications. */
  replayCachedPayloadsForPanes(): number {
    const cachedSnapshot = new Map(this.state.lastStatusByPaneKey)
    const replayable = selectReplayableCachedPanes({
      cachedByPaneKey: cachedSnapshot,
      metaByPaneKey: this.lastEnvelopeMetaByPaneKey,
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      dropPane: (paneKey) => this.clearPaneState(paneKey)
    })
    for (const { event, meta } of replayable) {
      void this.checkAgentPresence(event.paneKey)
      this.forward(
        buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, { isReplay: true })
      )
    }
    return replayable.length + this.replayCanonicalHooks()
  }

  checkAgentPresence(paneKey: string): Promise<void> {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    const meta = this.lastEnvelopeMetaByPaneKey.get(paneKey)
    return this.presenceChecks.check(
      row,
      () => this.state.lastStatusByPaneKey.get(paneKey),
      (event) => {
        if (meta) {
          this.applyEvent(event, meta.source, meta.env, meta.version)
        }
      }
    )
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane can't resurface as a ghost event on reconnect. */
  clearPaneState(paneKey: string, preserveTmuxInnerSubjects = false): void {
    if (!preserveTmuxInnerSubjects) {
      this.clearCanonicalPane(paneKey)
    }
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
    await handleRelayHookRequest(req, res, {
      token: this.token,
      env: this.env,
      state: this.state,
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      getAgentLaunchToken: this.getAgentLaunchToken,
      applyEvent: (event, source, env, version) => this.applyEvent(event, source, env, version),
      ingestTmuxHook: (source, body) => this.ingestCanonicalTmuxHook(source, body, this.env),
      retryScheduler: this.retryScheduler,
      transportInterference: this.transportInterference
    })
  }

  private applyEvent(
    incoming: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean; checkPresence?: boolean } = {}
  ): AgentHookEventPayload | undefined {
    if (this.isCanonicalPane(incoming.paneKey)) {
      return undefined
    }
    const transitioned = transitionHookPresence(
      incoming,
      this.state.lastStatusByPaneKey.get(incoming.paneKey)
    )
    if (!transitioned) {
      return undefined
    }
    const event = transitioned.agentPresence?.ended
      ? { ...transitioned, providerSessionOnly: true }
      : transitioned
    // Why: this post came from a process still running inside a pane whose tab the user closed.
    // Caching or forwarding it makes every connected client advertise a live, resumable agent pane
    // that no tab owns — the advertisement that ends up auto-typing a second `--resume` onto a
    // transcript the orphan is still writing (#12447). Drop the stale cache with it.
    if (this.isPaneSurfaceRetired(event.paneKey)) {
      this.clearPaneState(event.paneKey)
      return undefined
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
      return undefined
    }
    this.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
    this.forward(buildRelayHookEnvelope(event, source, env, version, options))
    const sender = incoming.agentPresence?.process
    const owner = event.agentPresence
    // Why: a live hook proves its own process alive; only another process's hook casts doubt on the owner.
    if (
      options.checkPresence !== false &&
      sender &&
      owner?.process &&
      !owner.ended &&
      !isSameAgentProcess(sender, owner.process)
    ) {
      void this.checkAgentPresence(event.paneKey)
    }
    // Why: retries compare against the cached row by identity, so they must hold that exact row.
    return this.state.lastStatusByPaneKey.get(event.paneKey)
  }

  private ingestSpoolRecord(record: SpoolRecord): void {
    ingestRelayHookSpoolRecord(record, this.state, this.env, {
      apply: (...args) => this.applyEvent(...args, { isReplay: true }),
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      getAgentLaunchToken: this.getAgentLaunchToken
    })
  }
}
