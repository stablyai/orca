/* eslint-disable max-lines -- Why: parsing, replay cache, endpoint writing, and retry state are one lifecycle unit; splitting obscures cleanup ordering across reconnects. */
// Relay-side adapter for the shared agent-hook listener: hosts a loopback HTTP server and
// forwards each parsed payload via a callback so `relay.ts` re-emits it as an `agent.hook`
// JSON-RPC notification over the SSH channel. Replay cache is bounded one-entry-per-paneKey —
// see docs/design/agent-status-over-ssh.md §5 (Path 3, request-driven replay) for the rationale.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { ORCA_HOOK_PROTOCOL_VERSION } from '../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  getEndpointFileName,
  hasPendingAgentResultText,
  HOOK_REQUEST_SLOWLORIS_MS,
  normalizeHookPayload,
  preparePendingGrokResultDiscovery,
  readRequestBody,
  resolveHookSource,
  writeEndpointFile,
  type AgentHookEventPayload,
  type HookListenerState
} from '../shared/agent-hook-listener'
import {
  REMOTE_AGENT_HOOK_ENV,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

// Why: relay's userData equivalent under $HOME so each user on a shared dev box gets their own 0o700 dir.
const RELAY_HOOKS_DIR_NAME = '.orca-relay'
const RELAY_HOOKS_SUBDIR = 'agent-hooks'
const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
const ASSISTANT_MESSAGE_RETRY_MS = 50

// Why: cap env/version at 64 chars so a misbehaving agent CLI can't grow the meta cache unboundedly; canonical values are short.
const MAX_HOOK_META_LEN = 64

// Why: WSL relay has no per-pane teardown (PTYs live on the Windows host), so the replay cache would grow forever without a recency cap.
const MAX_CACHED_PANES = 256

function defaultEndpointDir(): string {
  return join(homedir(), RELAY_HOOKS_DIR_NAME, RELAY_HOOKS_SUBDIR)
}

function isWindowsNamedPipePath(sockPath: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(sockPath)
}

function windowsNamedPipeEndpointName(sockPath: string): string {
  return (
    sockPath
      .replace(/^\\\\[.?]\\pipe\\/i, '')
      .split(/[\\/]/)
      .findLast(Boolean) ?? 'relay'
  )
}

export function endpointDirForRelaySocket(sockPath: string): string {
  if (isWindowsNamedPipePath(sockPath)) {
    return join(defaultEndpointDir(), windowsNamedPipeEndpointName(sockPath))
  }
  return join(dirname(sockPath), RELAY_HOOKS_SUBDIR, basename(sockPath))
}

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  /** Env tag forwarded into hook payloads. Defaults to "remote", which main excludes from dev-vs-prod mismatch warnings. */
  env?: string
  /** Fixed auth token. WSL relay passes the host-issued token (already in guest env via WSLENV) so unmodified hook clients authenticate. Defaults to a fresh UUID. */
  token?: string
  /** Preferred bind port. WSL relay passes the Windows listener's port so env-sourced client coords stay truthful; falls back to :0 if occupied. Defaults to :0. */
  preferredPort?: number
  /** Called once per parsed payload; the relay wires this to `dispatcher.notify('agent.hook', envelope)`. */
  forward: RelayHookForward
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
  // Why: shared status cache drops wire-envelope fields; this sidecar holds source/env/version so replay matches the live POST path.
  // Invariant: keys mirror state.lastStatusByPaneKey, populated/cleared in lockstep.
  private lastEnvelopeMetaByPaneKey: Map<
    string,
    { source: AgentHookSource; env?: string; version?: string }
  > = new Map()
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private forward: RelayHookForward
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false

  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
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
      // Why: preferred port is best-effort; on EADDRINUSE fall back to ephemeral and let clients re-coordinate via the endpoint file.
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

  /** True when the preferred port was occupied and the server fell back to an ephemeral bind. */
  get usedPortFallback(): boolean {
    return this.portFallbackApplied
  }

  private listenOn(port: number): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    return new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        // Why: null the server ref on bind failure so a later start() can retry (else the early-return at top of start() wedges it).
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
      version: ORCA_HOOK_PROTOCOL_VERSION
    })
    return this.endpointFileWritten
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    clearAllListenerCaches(this.state)
    this.lastEnvelopeMetaByPaneKey.clear()
  }

  /** Request-driven replay: re-forwards each cached paneKey payload as a fresh notification. Forwards are
   *  issued before the request handler returns, so the response trails all replayed notifications. */
  replayCachedPayloadsForPanes(): number {
    let count = 0
    for (const [paneKey, event] of this.state.lastStatusByPaneKey.entries()) {
      const meta = this.lastEnvelopeMetaByPaneKey.get(paneKey)
      // Why: invariant — status-cache keys always have meta; if it drifted, skip rather than guess a source that mis-tags downstream.
      if (!meta) {
        continue
      }
      this.forwardEvent(event, meta.source, meta.env, meta.version, { isReplay: true })
      count++
    }
    return count
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane can't resurface as a ghost event on reconnect. */
  clearPaneState(paneKey: string): void {
    this.clearAssistantMessageRetry(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
  }

  /** Env vars to inject into relay-spawned PTYs so the hook script/plugin POSTs back to this loopback server. */
  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }
    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION
    }
    if (this.endpointFileWritten) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePath
    }
    return env
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
    req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
      req.destroy()
    })
    try {
      const body = await readRequestBody(req)
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const source = resolveHookSource(pathname)
      if (!source) {
        res.writeHead(404)
        res.end()
        return
      }
      const event = normalizeHookPayload(this.state, source, body, this.env)
      if (event) {
        // TODO: once normalizeHookPayload returns validated env/version, drop bodyEnv/bodyVersion and source them from the listener result.
        const env = this.bodyEnv(body)
        const version = this.bodyVersion(body)
        this.applyEvent(event, source, env, version)
        this.scheduleAssistantMessageRetry(source, body, event, env, version)
      }
      res.writeHead(204)
      res.end()
    } catch (err) {
      // Why: hooks fail open (204 on any error) so a buggy agent never blocks the run; still log so the 204 doesn't mask bugs.
      process.stderr.write(
        `[relay-hook-server] hook request failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
      res.writeHead(204)
      res.end()
    }
  }

  private forwardEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean } = {}
  ): void {
    const envelope: AgentHookRelayEnvelope = {
      source,
      paneKey: event.paneKey,
      ...(event.launchToken ? { launchToken: event.launchToken } : {}),
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      connectionId: null,
      hasExplicitPrompt: event.hasExplicitPrompt,
      promptInteractionKey: event.promptInteractionKey,
      hookEventName: event.hookEventName,
      toolUseId: event.toolUseId,
      toolAgentId: event.toolAgentId,
      toolAgentType: event.toolAgentType,
      ...(event.providerSession ? { providerSession: event.providerSession } : {}),
      ...(event.providerSessionOnly ? { providerSessionOnly: true } : {}),
      isReplay: options.isReplay === true ? true : undefined,
      env,
      version,
      payload: event.payload
    }
    this.forward(envelope)
  }

  private applyEvent(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string
  ): void {
    if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
      this.clearAssistantMessageRetry(event.paneKey)
    }
    // Why: delete-then-set makes Map insertion order = recency, so the cap below evicts the longest-idle pane.
    this.state.lastStatusByPaneKey.delete(event.paneKey)
    this.state.lastStatusByPaneKey.set(event.paneKey, event)
    this.lastEnvelopeMetaByPaneKey.delete(event.paneKey)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
    while (this.state.lastStatusByPaneKey.size > MAX_CACHED_PANES) {
      const oldest = this.state.lastStatusByPaneKey.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.clearPaneState(oldest)
    }
    this.forwardEvent(event, source, env, version)
  }

  private clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  private scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string,
    attempt = 1,
    discoveryReady = false
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        // Why: slug-group discovery can outlive the bounded flush timers, so its completion drives the first retry.
        void discovery
          .then(() => {
            if (this.server) {
              this.applyAssistantMessageRetry(source, body, original, env, version, 1, true)
            }
          })
          .catch((err) => {
            process.stderr.write(
              `[relay-hook-server] Grok result discovery failed: ${err instanceof Error ? err.message : String(err)}\n`
            )
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(
          source,
          body,
          original,
          env,
          version,
          attempt + 1,
          discoveryReady
        )
      } catch (err) {
        process.stderr.write(
          `[relay-hook-server] assistant message retry failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env: string | undefined,
    version: string | undefined,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.state.lastStatusByPaneKey.get(original.paneKey)
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const event = normalizeHookPayload(this.state, source, body, this.env)
    if (!event?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(
        source,
        body,
        original,
        env,
        version,
        nextAttempt,
        requireExactOriginal
      )
      return
    }
    this.applyEvent(event, source, env, version)
  }

  private bodyEnv(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) {
      return undefined
    }
    const v = (body as Record<string, unknown>).env
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_HOOK_META_LEN) {
      return undefined
    }
    return v
  }

  private bodyVersion(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) {
      return undefined
    }
    const v = (body as Record<string, unknown>).version
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_HOOK_META_LEN) {
      return undefined
    }
    return v
  }
}
