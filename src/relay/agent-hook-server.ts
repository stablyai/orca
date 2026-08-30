import type { Server } from 'node:http'
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
import {
  getEndpointFileName,
  writeEndpointFile
} from '../shared/agent-hook-listener/endpoint-publication'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference
} from '../shared/agent-hook-transport-interference'
import {
  isAgentHookSource,
  REMOTE_AGENT_HOOK_ENV,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import {
  buildSpoolHookBody,
  drainAgentHookSpool,
  type SpoolRecord
} from '../shared/agent-hook-spool'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope, hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { listenRelayHttpServer } from './relay-http-listener'
import {
  hydrateRelayHookStatusCache,
  persistRelayHookStatusCache,
  type RelayHookStatusMeta
} from './agent-hook-status-cache'
import { createRelayCodexReconciliationSchedulers } from './agent-hook-codex-reconciliation'
import { RelayHookStatusCacheWriter } from './agent-hook-status-cache-writer'
import { handleRelayHookRequest } from './agent-hook-request'
import { applyRelayEvent } from './agent-hook-event-application'
import { selectReplayableCachedPanes } from './agent-hook-cached-pane-status'
import type {
  RelayHookForward,
  RelayHookServerOptions,
  RelayHookServerStartOptions
} from './agent-hook-server-options'

export type {
  RelayHookForward,
  RelayHookServerOptions,
  RelayHookServerStartOptions
} from './agent-hook-server-options'

const HOOK_STATUS_CACHE_FILE = 'hook-status-cache.json'

export class RelayAgentHookServer {
  private server: Server | null = null
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
  private lastEnvelopeMetaByPaneKey = new Map<string, RelayHookStatusMeta>()
  private forward: RelayHookForward
  private isPaneSurfaceRetired: (paneKey: string) => boolean
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private retryScheduler: AgentHookResultRetryScheduler
  private cacheFilePath: string
  private codexRestartReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private codexReconcileGate = { nextRunAt: 0 }
  private codexReconciliationSchedulers: ReturnType<typeof createRelayCodexReconciliationSchedulers>
  private statusCacheWriter: RelayHookStatusCacheWriter
  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.cacheFilePath = join(this.endpointDir, HOOK_STATUS_CACHE_FILE)
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.statusCacheWriter = new RelayHookStatusCacheWriter(() =>
      persistRelayHookStatusCache(
        this.endpointDir,
        this.cacheFilePath,
        this.state,
        this.lastEnvelopeMetaByPaneKey
      )
    )
    this.isPaneSurfaceRetired = options.isPaneSurfaceRetired ?? (() => false)
    this.retryScheduler = new AgentHookResultRetryScheduler({
      state: this.state,
      env: this.env,
      isListening: () => this.server !== null,
      applyEvent: (event, source, env, version) => {
        this.applyEvent(event, source, env, version)
      }
    })
    this.codexReconciliationSchedulers = createRelayCodexReconciliationSchedulers({
      state: this.state,
      isListening: () => this.server !== null,
      timers: this.codexRestartReconcileTimers,
      metadata: this.lastEnvelopeMetaByPaneKey,
      forward: this.forward,
      persist: () => this.statusCacheWriter.schedule(),
      gate: this.codexReconcileGate
    })
  }
  async start(options: RelayHookServerStartOptions = {}): Promise<void> {
    if (this.server) {
      return
    }
    this.token = this.fixedToken ?? randomUUID()
    this.endpointFileWritten = false
    this.portFallbackApplied = false
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
    const hydratedMetadata = hydrateRelayHookStatusCache(
      this.cacheFilePath,
      this.state,
      (paneKey) => this.codexReconciliationSchedulers.restart(paneKey)
    )
    this.lastEnvelopeMetaByPaneKey.clear()
    for (const [paneKey, metadata] of hydratedMetadata) {
      this.lastEnvelopeMetaByPaneKey.set(paneKey, metadata)
    }
    this.statusCacheWriter.schedule()
    try {
      drainAgentHookSpool({
        endpointDir: this.endpointDir,
        getPersistedLaunchTokenHash: () => undefined,
        ingest: (record) => this.ingestSpoolRecord(record)
      })
    } catch (err) {
      process.stderr.write(
        `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
    if (options.publishEndpoint !== false) {
      this.publishEndpointFile()
    }
  }
  get usedPortFallback(): boolean {
    return this.portFallbackApplied
  }
  private listenOn(port: number): Promise<void> {
    return listenRelayHttpServer(port, (req, res) =>
      handleRelayHookRequest(req, res, {
        token: this.token,
        env: this.env,
        state: this.state,
        transportInterference: this.transportInterference,
        applyEvent: (event, source, env, version) => this.applyEvent(event, source, env, version),
        scheduleAssistantMessageRetry: (source, body, event, env, version) =>
          this.retryScheduler.scheduleAssistantMessageRetry(source, body, event, env, version),
        scheduleCodexSubagentPoll: (source, body, event, env, version) =>
          this.retryScheduler.scheduleCodexSubagentPoll(source, body, event, env, version),
        bodyEnv: hookBodyEnv,
        bodyVersion: hookBodyVersion
      })
    ).then((result) => {
      this.server = result.server
      this.port = result.port
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
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    return this.endpointFileWritten
  }
  stop(): void {
    this.statusCacheWriter.flush()
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    this.retryScheduler.clearAll()
    for (const timer of this.codexRestartReconcileTimers.values()) {
      clearTimeout(timer)
    }
    this.codexRestartReconcileTimers.clear()
    this.codexReconcileGate.nextRunAt = 0
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
  }
  replayCachedPayloadsForPanes(): number {
    const replayable = selectReplayableCachedPanes({
      cachedByPaneKey: this.state.lastStatusByPaneKey,
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

  clearPaneState(paneKey: string): void {
    this.retryScheduler.clearAssistantMessageRetry(paneKey)
    this.retryScheduler.clearCodexSubagentPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
    const timer = this.codexRestartReconcileTimers.get(paneKey)
    if (timer) {
      clearTimeout(timer)
      this.codexRestartReconcileTimers.delete(paneKey)
    }
    this.statusCacheWriter.schedule()
  }

  buildPtyEnv(): Record<string, string> {
    return buildRelayHookPtyEnv({
      port: this.port,
      token: this.token,
      env: this.env,
      endpointFilePath: this.endpointFilePath,
      endpointFileWritten: this.endpointFileWritten
    })
  }

  getCoordinates(): { port: number; token: string; endpointFilePath: string } {
    return { port: this.port, token: this.token, endpointFilePath: this.endpointFilePath }
  }

  // ─── Private ──────────────────────────────────────────────────────
  private ingestSpoolRecord(record: SpoolRecord): void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const cachedAt = this.lastEnvelopeMetaByPaneKey.get(record.paneKey)?.receivedAt
    if (cachedAt !== undefined && record.receivedAt <= cachedAt) {
      return
    }
    const body = buildSpoolHookBody(record)
    const event = normalizeHookPayload(this.state, record.source, body, this.env, {
      deferCompactOwnershipToClient: true
    })
    if (!event) {
      return
    }
    this.applyEvent(event, record.source, hookBodyEnv(body), hookBodyVersion(body), {
      isReplay: true,
      receivedAt: record.receivedAt
    })
  }

  private applyEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean; receivedAt?: number } = {}
  ): void {
    if (!this.server) {
      return
    }
    applyRelayEvent({
      state: this.state,
      event,
      source,
      env,
      version,
      receivedAt: options.receivedAt,
      isReplay: options.isReplay,
      metadata: this.lastEnvelopeMetaByPaneKey,
      persist: () => this.statusCacheWriter.schedule(),
      clearPaneState: (paneKey) => this.clearPaneState(paneKey),
      forward: this.forward,
      scheduleCodexReconciliation: this.codexReconciliationSchedulers.live,
      scheduleCodexRestartReconciliation: this.codexReconciliationSchedulers.restart,
      clearAssistantMessageRetry: (paneKey) =>
        this.retryScheduler.clearAssistantMessageRetry(paneKey),
      isPaneSurfaceRetired: this.isPaneSurfaceRetired
    })
  }
}
