import {
  inferRelayClaudeInterrupt,
  type RelayInterruptHost
} from './agent-hook-interrupt-reconciliation'
import {
  applyRelayHookEvent,
  endRelayPaneOwner,
  type RelayHookAdmissionHost
} from './agent-hook-event-admission'
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
import { listenOnLoopback } from './agent-hook-loopback-listener'
import { RelayAgentPresence } from './relay-agent-presence'
import { PaneOwnerProbes } from '../shared/agent-pane-owner-probes'
import { commandEndEndsRow, confirmCommandEnd } from '../shared/agent-command-end'
import { currentOwner } from '../shared/agent-hook-presence-transition'
import type { FinishedCommand } from '../shared/command-foreground-tracker'
import type { AgentProcessVerdict } from '../shared/agent-process-presence'
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
import { REMOTE_AGENT_HOOK_ENV, type AgentHookSource } from '../shared/agent-hook-relay'
import type { SpoolRecord } from '../shared/agent-hook-spool'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import { drainRelayHookSpool, ingestRelayHookSpoolRecord } from './agent-hook-spool-ingest'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import {
  selectReplayableCachedPanes,
  type CachedPaneEnvelopeMeta
} from './agent-hook-cached-pane-status'
import { createRelayClaudeTerminalInterrupts } from './claude-terminal-interrupt-status'

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
  private lastEnvelopeMetaByPaneKey = new Map<string, CachedPaneEnvelopeMeta>()
  private forward: RelayHookForward
  private isPaneSurfaceRetired: (paneKey: string) => boolean
  private getAgentLaunchToken: (paneKey: string) => string | undefined
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private readonly presenceChecks = new RelayAgentPresence({
    current: (paneKey) => this.state.lastStatusByPaneKey.get(paneKey),
    end: (paneKey) => endRelayPaneOwner(this.admissionHost(), paneKey)
  })
  private readonly ownerProbes = new PaneOwnerProbes({
    ownerOf: (paneKey) => currentOwner(this.state.lastStatusByPaneKey.get(paneKey))?.process,
    checkOwner: (paneKey) => this.presenceChecks.check(paneKey)
  })
  private retryScheduler: AgentHookResultRetryScheduler
  readonly claudeTerminalInterrupts = createRelayClaudeTerminalInterrupts(this.state, () =>
    this.relayInterruptHost()
  )

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
        this.applyEvent(event, source, env, version)
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

  private async listenOn(port: number): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    try {
      this.port = (await listenOnLoopback(this.server, port)) ?? this.port
    } catch (err) {
      // Why: clear failed server refs so later start() calls can retry.
      this.server = null
      throw err
    }
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
    this.claudeTerminalInterrupts.clear()
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

  inferInterrupt(request: unknown): boolean {
    return inferRelayClaudeInterrupt(this.relayInterruptHost(), request)
  }

  private relayInterruptHost(): RelayInterruptHost {
    return {
      state: this.state,
      isListening: this.server !== null,
      getMetadata: (paneKey) => this.lastEnvelopeMetaByPaneKey.get(paneKey),
      getAgentLaunchToken: this.getAgentLaunchToken,
      isPaneBlocked: (paneKey) =>
        this.isCanonicalPane(paneKey) || this.isPaneSurfaceRetired(paneKey),
      apply: (event, meta) => this.applyEvent(event, meta.source, meta.env, meta.version),
      armExpiry: (paneKey, meta) =>
        this.retryScheduler.armClaudeOwedNotificationExpiry(
          meta.source,
          paneKey,
          meta.env,
          meta.version
        )
    }
  }

  checkAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null> {
    return this.ownerProbes.check(paneKey)
  }

  /** A command finished in this pane: end the agent it ran (the host's command-end rule). */
  async endCommand(paneKey: string, command: FinishedCommand): Promise<void> {
    const row = () => this.state.lastStatusByPaneKey.get(paneKey)
    const writtenAt = () => this.lastEnvelopeMetaByPaneKey.get(paneKey)?.writtenAt
    if (await confirmCommandEnd(() => commandEndEndsRow(row(), writtenAt(), command), command)) {
      const owner = currentOwner(row())
      if (owner && endRelayPaneOwner(this.admissionHost(), paneKey)) {
        this.ownerProbes.ownerEnded(paneKey, owner.process)
      }
    }
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane can't resurface as a ghost event on reconnect. */
  clearPaneState(paneKey: string, preserveTmuxInnerSubjects = false): void {
    this.claudeTerminalInterrupts.observe(paneKey, { kind: 'reset' })
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

  private admissionHost(): RelayHookAdmissionHost {
    return {
      state: this.state,
      metadata: this.lastEnvelopeMetaByPaneKey,
      isCanonicalPane: (paneKey) => this.isCanonicalPane(paneKey),
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      clearPaneState: (paneKey) => this.clearPaneState(paneKey),
      clearAssistantMessageRetry: (paneKey) =>
        this.retryScheduler.clearAssistantMessageRetry(paneKey),
      forward: this.forward,
      ownerProbes: this.ownerProbes
    }
  }

  private applyEvent(
    incoming: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean } = {}
  ): AgentHookEventPayload | undefined {
    return applyRelayHookEvent(this.admissionHost(), incoming, source, env, version, options)
  }

  private ingestSpoolRecord(record: SpoolRecord): void {
    ingestRelayHookSpoolRecord(record, this.state, this.env, {
      apply: (...args) => this.applyEvent(...args, { isReplay: true }),
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      getAgentLaunchToken: this.getAgentLaunchToken
    })
  }
}
