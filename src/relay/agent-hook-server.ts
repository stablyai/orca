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
import {
  getEndpointFileName,
  writeEndpointFile
} from '../shared/agent-hook-listener/endpoint-publication'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference
} from '../shared/agent-hook-transport-interference'
import {
  REMOTE_AGENT_HOOK_ENV,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { drainAgentHookSpool } from '../shared/agent-hook-spool'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import { RelayAgentStatusStoreSource } from './agent-hook-status-store-source'
import { handleRelayHookHttpRequest } from './agent-hook-http-handler'
import { ingestRelaySpoolRecord, replayCachedRelayPayloads } from './agent-hook-cache-actions'

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
  private readonly statusStoreSource: RelayAgentStatusStoreSource

  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.isPaneSurfaceRetired = options.isPaneSurfaceRetired ?? (() => false)
    this.statusStoreSource = new RelayAgentStatusStoreSource(this.state)
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
    try {
      drainAgentHookSpool({
        endpointDir: this.endpointDir,
        getPersistedLaunchTokenHash: () => undefined,
        ingest: (record) =>
          ingestRelaySpoolRecord({
            record,
            state: this.state,
            env: this.env,
            applyEvent: (event, source, env, version, eventOptions) =>
              this.applyEvent(event, source, env, version, eventOptions)
          })
      })
    } catch (err) {
      // Why: a downstream relay failure must not prevent the loopback listener from starting;
      // the untruncated spool file remains available for retry on the next restart.
      process.stderr.write(
        `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
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
    this.retryScheduler.clearAll()
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
    this.statusStoreSource.reset()
  }

  createStatusStorePublisher(
    options: Parameters<RelayAgentStatusStoreSource['createPublisher']>[0]
  ) {
    return this.statusStoreSource.createPublisher(options)
  }
  getStatusSnapshot() {
    return this.statusStoreSource.getSnapshot()
  }

  getStatusSnapshotForPane(paneKey: string) {
    return this.statusStoreSource.getRowsForPane(paneKey)
  }
  replayCachedPayloadsForPanes(): number {
    return replayCachedRelayPayloads({
      cachedByPaneKey: this.state.lastStatusByPaneKey,
      metaByPaneKey: this.lastEnvelopeMetaByPaneKey,
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      dropPane: (paneKey) => this.clearPaneState(paneKey),
      forward: this.forward
    })
  }

  clearPaneState(paneKey: string): void {
    const previous = this.state.lastStatusByPaneKey.get(paneKey)
    this.retryScheduler.clearAssistantMessageRetry(paneKey)
    this.retryScheduler.clearCodexSubagentPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
    this.statusStoreSource.clearPane(paneKey, previous)
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
    return handleRelayHookHttpRequest(req, res, {
      token: this.token,
      env: this.env,
      state: this.state,
      retryScheduler: this.retryScheduler,
      transportInterference: this.transportInterference,
      applyEvent: (event, source, env, version) => this.applyEvent(event, source, env, version)
    })
  }

  private applyEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean } = {}
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
    const previous = this.state.lastStatusByPaneKey.get(event.paneKey)
    if (
      !cacheRelayLegacyAgentStatus(this.state, event, 256, (paneKey) =>
        this.clearPaneState(paneKey)
      )
    ) {
      return
    }
    this.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
    this.statusStoreSource.recordEvent(event, previous)
    this.forward(buildRelayHookEnvelope(event, source, env, version, options))
  }
}
