/* eslint-disable max-lines -- Why: relay hook parsing, replay cache, endpoint
   writing, and assistant-message retry state are one lifecycle unit; splitting
   them would obscure cleanup ordering across remote PTY reconnects. */
// Why: relay-side adapter for the shared agent-hook listener pipeline. Hosts
// a loopback HTTP server (same shape as Orca's main-process server: bind
// 127.0.0.1:0, bearer-token auth, /hook/<source> routing) and forwards every
// parsed payload via a callback so `relay.ts` can re-emit it as an
// `agent.hook` JSON-RPC notification across the existing SSH channel.
//
// Per-instance state (warn-once Sets, last-status cache, last-prompt /
// last-tool caches) lives on `HookListenerState`. The cache is bounded to one
// entry per paneKey — see docs/design/agent-status-over-ssh.md §5 (Path 3,
// request-driven replay) for the rationale.
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { ORCA_HOOK_PROTOCOL_VERSION } from '../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  getEndpointFileName,
  hasPendingAgentResultText,
  HOOK_REQUEST_SLOWLORIS_MS,
  normalizeHookPayload,
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

// Why: relay's userData equivalent. Lives under $HOME so each user on a
// shared dev box gets their own dir, owned 0o700. Mirrors RELAY_REMOTE_DIR
// from `ssh-relay-deploy.ts` but stays local to this module — the hook
// server is the only consumer.
const RELAY_HOOKS_DIR_NAME = '.orca-relay'
const RELAY_HOOKS_SUBDIR = 'agent-hooks'
const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
const ASSISTANT_MESSAGE_RETRY_MS = 50

// Why: cap env/version metadata at 64 chars so a misbehaving agent CLI
// cannot grow lastEnvelopeMetaByPaneKey unboundedly per pane via the cache
// + replay path. Canonical values are short ('production'/'development',
// '1'/'999'); anything longer is treated as absent.
const MAX_HOOK_META_LEN = 64

function defaultEndpointDir(): string {
  return join(homedir(), RELAY_HOOKS_DIR_NAME, RELAY_HOOKS_SUBDIR)
}

export function endpointDirForRelaySocket(sockPath: string): string {
  return join(dirname(sockPath), RELAY_HOOKS_SUBDIR, basename(sockPath))
}

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  /** Env tag forwarded into hook payloads. Defaults to "remote", a relay
   *  location marker that main excludes from dev-vs-prod mismatch warnings. */
  env?: string
  /** Called once per parsed payload. The relay wires this to
   *  `dispatcher.notify('agent.hook', envelope)`. */
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
  // Why: the shared `HookListenerState.lastStatusByPaneKey` cache only stores
  // `AgentHookEventPayload` (no wire-envelope fields). Replay must still emit
  // the original `source`/`env`/`version` so Orca's warn-once diagnostics fire
  // identically to the live POST path. Keep this as a per-instance sidecar map
  // so the shared listener type stays unchanged. Invariant: every key present
  // in `state.lastStatusByPaneKey` must also be present here — populated and
  // cleared in lockstep on the live POST path, clearPaneState, and stop().
  private lastEnvelopeMetaByPaneKey: Map<
    string,
    { source: AgentHookSource; env?: string; version?: string }
  > = new Map()
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private forward: RelayHookForward

  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.forward = options.forward
  }

  async start(options: RelayHookServerStartOptions = {}): Promise<void> {
    if (this.server) {
      return
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.server = createServer((req, res) => this.handleRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        // Why: null the server reference on bind failure so a subsequent
        // start() can retry. Without this, a failed bind (e.g. EMFILE) leaves
        // this.server populated and the early-return at the top of start()
        // wedges the relay into a permanently broken state until stop() runs.
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
        if (options.publishEndpoint !== false) {
          this.publishEndpointFile()
        }
        resolve()
      }
      this.server!.once('error', onStartupError)
      // Why: bind 127.0.0.1:0 so the OS assigns a free port. Loopback only —
      // the agent CLI inside the same remote box reaches us via curl
      // 127.0.0.1:PORT; nobody outside the box can.
      this.server!.listen(0, '127.0.0.1', onListening)
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

  /** Request-driven replay: walks the per-paneKey last-payload cache and
   *  forwards each entry as a fresh notification. Called after Orca has
   *  re-wired its `agent.hook` handler on the new mux post-`--connect`.
   *  The relay-driver issues the replay forwards BEFORE returning from the
   *  request handler so the response strictly trails all replayed
   *  notifications on the dispatcher's single write callback. */
  replayCachedPayloadsForPanes(): number {
    let count = 0
    for (const [paneKey, event] of this.state.lastStatusByPaneKey.entries()) {
      const meta = this.lastEnvelopeMetaByPaneKey.get(paneKey)
      // Why: invariant — every paneKey in the shared status cache is populated
      // in lockstep with `lastEnvelopeMetaByPaneKey`. If meta is missing,
      // something has drifted; skip rather than fall back to a guessed source
      // that would mis-tag the event downstream.
      if (!meta) {
        continue
      }
      this.forwardEvent(event, meta.source, meta.env, meta.version, { isReplay: true })
      count++
    }
    return count
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane never
   *  resurfaces as a ghost event on a later reconnect. Symmetric with the
   *  local server's clearPaneState on PTY teardown. */
  clearPaneState(paneKey: string): void {
    this.clearAssistantMessageRetry(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
  }

  /** Env vars to inject into every relay-spawned PTY so the hook script /
   *  in-process plugin POSTs to this loopback server. */
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
        // TODO: once normalizeHookPayload returns validated env/version, drop
        // bodyEnv/bodyVersion and source those from the listener result instead.
        const env = this.bodyEnv(body)
        const version = this.bodyVersion(body)
        this.applyEvent(event, source, env, version)
        this.scheduleAssistantMessageRetry(source, body, event, env, version)
      }
      res.writeHead(204)
      res.end()
    } catch (err) {
      // Why: agent hooks must fail open — return success on parse / size /
      // timeout errors so a buggy agent script never blocks the agent run.
      // Log the swallowed error to stderr so future programmer bugs are not
      // invisible (the 204 response would otherwise mask them entirely).
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
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      connectionId: null,
      hasExplicitPrompt: event.hasExplicitPrompt,
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
    this.state.lastStatusByPaneKey.set(event.paneKey, event)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
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
    attempt = 1
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        const current = this.state.lastStatusByPaneKey.get(original.paneKey)
        if (
          !current ||
          current.payload.agentType !== original.payload.agentType ||
          current.payload.prompt !== original.payload.prompt ||
          current.payload.lastAssistantMessage
        ) {
          return
        }
        const event = normalizeHookPayload(this.state, source, body, this.env)
        if (!event?.payload.lastAssistantMessage) {
          this.scheduleAssistantMessageRetry(source, body, original, env, version, attempt + 1)
          return
        }
        // Why: the relay runs on SSH targets too; retry from a timer so a delayed
        // transcript/chat-history write does not block the remote hook server.
        this.applyEvent(event, source, env, version)
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
