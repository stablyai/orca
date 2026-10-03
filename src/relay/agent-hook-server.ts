import type { AgentRunEvidence } from '../shared/agent-presence-command-observer'
import { applyRelayAgentEvent, type RelayEventOptions } from './agent-hook-event-admission'
import type {
  RelayHookForward,
  RelayHookServerOptions,
  RelayHookServerStartOptions
} from './agent-hook-server-options'
import { createRelayAgentPresenceObservation } from './relay-agent-presence-observation'
import { handleRelayHookRequest } from './agent-hook-request'
import { admitRelayForegroundOwner, RelayAgentPresence } from './relay-agent-presence'
import type { AgentProcessPresence } from '../shared/agent-process-presence'
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
import { selectReplayableCachedPanes } from './agent-hook-cached-pane-status'

export type * from './agent-hook-server-options'
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
    { source?: AgentHookSource; env?: string; version?: string }
  >()
  private forward: RelayHookForward
  private isPaneSurfaceRetired: (paneKey: string) => boolean
  private readonly onAgentEvidence?: (
    paneKey: string,
    agent: string,
    run: AgentRunEvidence
  ) => void
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private readonly observePresence = createRelayAgentPresenceObservation()
  private readonly presenceChecks = new RelayAgentPresence({
    rows: () => this.state.lastStatusByPaneKey.values(),
    checkOwner: (paneKey) => this.checkAgentPresence(paneKey)
  })

  private retryScheduler: AgentHookResultRetryScheduler

  constructor(options: RelayHookServerOptions) {
    this.onAgentEvidence = options.onAgentEvidence
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
        this.applyEvent(event, source, env, version, { checkPresence: false })
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
        ingest: (record) => this.ingestSpoolRecord(record)
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
    this.presenceChecks.stop()
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
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
    return replayable.length
  }

  hasAgentOwner(paneKey: string): boolean {
    const presence = this.state.lastStatusByPaneKey.get(paneKey)?.agentPresence
    return Boolean(presence?.process && !presence.ended)
  }

  ingestForegroundPresence(
    scope: Pick<AgentHookEventPayload, 'paneKey' | 'tabId' | 'worktreeId' | 'terminalHandle'>,
    presence: AgentProcessPresence
  ): Promise<void> {
    return admitRelayForegroundOwner(
      () => this.state.lastStatusByPaneKey.get(scope.paneKey),
      scope,
      presence,
      (row) => this.applyEvent(row, undefined, undefined, undefined, { hostPresence: true })
    )
  }

  checkAgentPresence(paneKey: string): Promise<void> {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    const meta = this.lastEnvelopeMetaByPaneKey.get(paneKey)
    return this.presenceChecks.check(
      row,
      () => this.state.lastStatusByPaneKey.get(paneKey),
      (event) => {
        if (meta) {
          this.applyEvent(event, meta.source, meta.env, meta.version, {
            hostPresence: true
          })
        }
      }
    )
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
    await handleRelayHookRequest(req, res, {
      token: this.token,
      env: this.env,
      state: this.state,
      applyEvent: (event, source, env, version) => this.applyEvent(event, source, env, version),
      retryScheduler: this.retryScheduler,
      transportInterference: this.transportInterference
    })
  }

  private applyEvent(
    incoming: AgentHookEventPayload,
    source: AgentHookSource | undefined,
    env?: string,
    version?: string,
    options: RelayEventOptions = {}
  ): AgentHookEventPayload | undefined {
    return applyRelayAgentEvent(
      {
        state: this.state,
        observePresence: this.observePresence,
        isPaneSurfaceRetired: this.isPaneSurfaceRetired,
        clearPaneState: (key) => this.clearPaneState(key),
        retryScheduler: this.retryScheduler,
        lastEnvelopeMetaByPaneKey: this.lastEnvelopeMetaByPaneKey,
        forward: this.forward,
        presenceChecks: this.presenceChecks,
        onAgentEvidence: this.onAgentEvidence
      },
      incoming,
      source,
      env,
      version,
      options
    )
  }

  private ingestSpoolRecord(record: SpoolRecord): void {
    if (!isAgentHookSource(record.source)) {
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
      isReplay: true
    })
  }
}
