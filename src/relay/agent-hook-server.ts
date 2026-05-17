/* eslint-disable max-lines -- Why: relay hook parsing, replay cache, endpoint
   writing, and Copilot transcript retry state are one lifecycle unit; splitting
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
const COPILOT_TRANSCRIPT_RETRY_ATTEMPTS = 5
const COPILOT_TRANSCRIPT_RETRY_MS = 50

// Why: cap env/version metadata at 64 chars so a misbehaving agent CLI
// cannot grow lastEnvelopeMetaByPaneKey unboundedly per pane via the cache
// + replay path. Canonical values are short ('production'/'development',
// '1'/'999'); anything longer is treated as absent.
const MAX_HOOK_META_LEN = 64

function defaultEndpointDir(): string {
  return join(homedir(), RELAY_HOOKS_DIR_NAME, RELAY_HOOKS_SUBDIR)
}

function hasPendingCopilotTranscript(source: AgentHookSource, body: unknown): boolean {
  if (source !== 'copilot' || typeof body !== 'object' || body === null) {
    return false
  }
  const rawPayload = (body as Record<string, unknown>).payload
  const payload =
    typeof rawPayload === 'string'
      ? (() => {
          try {
            return JSON.parse(rawPayload) as unknown
          } catch {
            return null
          }
        })()
      : rawPayload
  if (typeof payload !== 'object' || payload === null) {
    return false
  }
  const record = payload as Record<string, unknown>
  const directMessage =
    record.last_assistant_message ?? record.lastAssistantMessage ?? record.message
  if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
    return false
  }
  const transcriptPath = record.transcript_path ?? record.transcriptPath
  return typeof transcriptPath === 'string' && transcriptPath.trim().length > 0
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
  private copilotTranscriptRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private forward: RelayHookForward

  constructor(options: RelayHookServerOptions) {
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.forward = options.forward
  }

  async start(): Promise<void> {
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
        this.endpointFileWritten = writeEndpointFile(this.endpointDir, this.endpointFilePath, {
          port: this.port,
          token: this.token,
          env: this.env,
          version: ORCA_HOOK_PROTOCOL_VERSION
        })
        resolve()
      }
      this.server!.once('error', onStartupError)
      // Why: bind 127.0.0.1:0 so the OS assigns a free port. Loopback only —
      // the agent CLI inside the same remote box reaches us via curl
      // 127.0.0.1:PORT; nobody outside the box can.
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    for (const timer of this.copilotTranscriptRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.copilotTranscriptRetryTimers.clear()
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
      this.forwardEvent(event, meta.source, meta.env, meta.version)
      count++
    }
    return count
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane never
   *  resurfaces as a ghost event on a later reconnect. Symmetric with the
   *  local server's clearPaneState on PTY teardown. */
  clearPaneState(paneKey: string): void {
    this.clearCopilotTranscriptRetry(paneKey)
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
        this.scheduleCopilotTranscriptRetry(source, body, event, env, version)
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
    version?: string
  ): void {
    const envelope: AgentHookRelayEnvelope = {
      source,
      paneKey: event.paneKey,
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      connectionId: null,
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
      this.clearCopilotTranscriptRetry(event.paneKey)
    }
    this.state.lastStatusByPaneKey.set(event.paneKey, event)
    this.lastEnvelopeMetaByPaneKey.set(event.paneKey, { source, env, version })
    this.forwardEvent(event, source, env, version)
  }

  private clearCopilotTranscriptRetry(paneKey: string): void {
    const timer = this.copilotTranscriptRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.copilotTranscriptRetryTimers.delete(paneKey)
  }

  private scheduleCopilotTranscriptRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string,
    attempt = 1
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingCopilotTranscript(source, body) ||
      attempt > COPILOT_TRANSCRIPT_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearCopilotTranscriptRetry(original.paneKey)
    const timer = setTimeout(() => {
      try {
        this.copilotTranscriptRetryTimers.delete(original.paneKey)
        const current = this.state.lastStatusByPaneKey.get(original.paneKey)
        if (
          !current ||
          current.payload.agentType !== 'copilot' ||
          current.payload.prompt !== original.payload.prompt ||
          current.payload.lastAssistantMessage
        ) {
          return
        }
        const event = normalizeHookPayload(this.state, source, body, this.env)
        if (!event?.payload.lastAssistantMessage) {
          this.scheduleCopilotTranscriptRetry(source, body, original, env, version, attempt + 1)
          return
        }
        // Why: the relay runs on SSH targets too; retry from a timer so a delayed
        // Copilot transcript does not block the remote hook server's event loop.
        this.applyEvent(event, source, env, version)
      } catch (err) {
        process.stderr.write(
          `[relay-hook-server] copilot transcript retry failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }, COPILOT_TRANSCRIPT_RETRY_MS)
    this.copilotTranscriptRetryTimers.set(original.paneKey, timer)
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
