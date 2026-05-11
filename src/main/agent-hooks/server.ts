// Why: this module is the Orca-main-process adapter for the shared
// agent-hook listener pipeline (`src/shared/agent-hook-listener.ts`). The
// listener internals (request parsing, payload normalization, endpoint-file
// writing, validation) live in `shared/` so the relay can host the same
// pipeline on the remote without dragging Electron in. This file owns:
//   - the loopback HTTP socket + bearer-token auth
//   - the IPC fanout (setListener / lastStatusByPaneKey replay)
//   - the `ingestRemote` entry point that bypasses HTTP for relay-forwarded
//     events (see docs/design/agent-status-over-ssh.md §5)
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { join } from 'path'

import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  getEndpointFileName,
  HOOK_REQUEST_SLOWLORIS_MS,
  MAX_PANE_KEY_LEN,
  normalizeHookPayload,
  parseFormEncodedBody,
  readRequestBody,
  resolveHookSource,
  writeEndpointFile,
  type AgentHookEventPayload,
  type HookListenerState
} from '../../shared/agent-hook-listener'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../shared/agent-status-types'

export type { AgentHookSource }

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so hook scripts can stamp requests and
  // the server can detect dev vs. prod cross-talk. Set at start() from the
  // caller's knowledge of whether this is a packaged build.
  private env = 'production'
  private onAgentStatus: ((payload: AgentHookEventPayload) => void) | null = null
  // Why: directory that holds the on-disk endpoint file. Set via start()'s
  // `userDataPath` option so the class has no direct Electron dependency
  // (keeps it mockable in the vitest node environment).
  private endpointDir: string | null = null
  private endpointFilePathCache: string | null = null
  private endpointFileWritten = false
  // Why: per-instance caches (warn-once Sets, lastPrompt/lastTool/lastStatus
  // by paneKey). Held on the instance instead of as module-level Maps so
  // tests can spin up multiple servers without state cross-contamination.
  private state: HookListenerState = createHookListenerState()

  setListener(listener: ((payload: AgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
    if (!listener) {
      return
    }
    // Why: replay is best-effort per pane so one throwing listener call can't
    // starve subsequent panes from being replayed.
    for (const payload of this.state.lastStatusByPaneKey.values()) {
      try {
        listener(payload)
      } catch (err) {
        console.error('[agent-hooks] replay listener threw', err)
      }
    }
  }

  /** Ingest a payload that arrived over the relay JSON-RPC channel rather
   *  than the local HTTP server. `connectionId` is the SshChannelMultiplexer
   *  identity Orca holds (the wire envelope carries connectionId: null and
   *  Orca stamps the real value here). The relay pre-normalizes the inner
   *  payload via the shared listener module; we re-run the canonical
   *  normalizer here as a defense-in-depth check at the trust boundary
   *  before feeding the event into the same `onAgentStatus` fanout the HTTP
   *  path uses. See docs/design/agent-status-over-ssh.md §5. */
  ingestRemote(
    envelope: {
      paneKey: string
      tabId?: string
      worktreeId?: string
      // Why: forwarded verbatim from the agent CLI POST body on the remote so
      // the warn-once cross-build / dev-vs-prod diagnostics fire identically
      // to the local HTTP path. Declared on the type now; consumed in PR2.
      env?: string
      version?: string
      payload: unknown
    },
    connectionId: string
  ): void {
    // Why: signature says non-empty, but the wire crosses a trust boundary —
    // re-check at runtime (and trim) so a whitespace-only or empty
    // connectionId can't poison caches.
    if (typeof connectionId !== 'string') {
      return
    }
    const trimmedConnectionId = connectionId.trim()
    if (trimmedConnectionId.length === 0) {
      return
    }
    if (!envelope || typeof envelope.paneKey !== 'string' || envelope.paneKey.length === 0) {
      return
    }
    // Why: match the listener's HTTP path — `normalizeHookPayload` trims and
    // length-caps paneKey before caching, so the cache key here must follow
    // the same rule or remote-vs-local events for the same pane would diverge.
    const paneKey = envelope.paneKey.trim()
    if (paneKey.length === 0 || paneKey.length > MAX_PANE_KEY_LEN) {
      return
    }
    if (envelope.tabId !== undefined && typeof envelope.tabId !== 'string') {
      return
    }
    if (envelope.worktreeId !== undefined && typeof envelope.worktreeId !== 'string') {
      return
    }
    // Why: mirror the HTTP path's `readStringField` behavior — trim and treat
    // empty-after-trim as undefined rather than letting a literal "" leak
    // into the event.
    const tabId =
      envelope.tabId !== undefined && envelope.tabId.trim().length > 0
        ? envelope.tabId.trim()
        : undefined
    const worktreeId =
      envelope.worktreeId !== undefined && envelope.worktreeId.trim().length > 0
        ? envelope.worktreeId.trim()
        : undefined
    // Why: the relay is across a trust boundary; re-run the canonical
    // normalizer on the inner payload so prompt/agentType/toolName/toolInput
    // length caps, embedded-newline collapse, and the `interrupted`-only-on-
    // done invariant are enforced here too. Returns null on malformed input
    // (including invalid state), which subsumes the prior explicit state
    // check.
    const normalizedPayload = normalizeAgentStatusPayload(envelope.payload)
    if (!normalizedPayload) {
      return
    }
    const event: AgentHookEventPayload = {
      paneKey,
      tabId,
      worktreeId,
      connectionId: trimmedConnectionId,
      payload: normalizedPayload
    }
    this.state.lastStatusByPaneKey.set(paneKey, event)
    this.onAgentStatus?.(event)
  }

  async start(options?: { env?: string; userDataPath?: string }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    if (options?.userDataPath) {
      this.endpointDir = join(options.userDataPath, 'agent-hooks')
      this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

      // Why: bound request time so a slow/stalled client cannot hold a socket
      // open indefinitely (slowloris-style). The hook endpoints are local and
      // should complete in well under a second.
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

        const payload = normalizeHookPayload(this.state, source, body, this.env)
        if (payload) {
          this.state.lastStatusByPaneKey.set(payload.paneKey, payload)
          this.onAgentStatus?.(payload)
        }

        res.writeHead(204)
        res.end()
      } catch {
        // Why: agent hooks must fail open. The receiver returns success for
        // malformed payloads so a newer or broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      // Why: swap the startup error handler on success so a later runtime
      // error (e.g. EADDRINUSE during rebind, socket errors) doesn't reject
      // an already-settled promise or crash the main process as unhandled.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        this.maybeWriteEndpointFile()
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
    // Why: intentionally do NOT delete the endpoint file on stop(). A stale
    // file points at a dead port, which matches the fail-open policy. Unlink
    // would introduce a TOCTOU race vs. a concurrent Orca instance.
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    clearAllListenerCaches(this.state)
  }

  clearPaneState(paneKey: string): void {
    clearPaneCacheState(this.state, paneKey)
  }

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
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

  private maybeWriteEndpointFile(): void {
    if (!this.endpointDir || !this.endpointFilePathCache) {
      return
    }
    this.endpointFileWritten = false
    const ok = writeEndpointFile(this.endpointDir, this.endpointFilePathCache, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION
    })
    this.endpointFileWritten = ok
  }
}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors.
export const _internals = {
  // Why: bind the test-helper to the singleton's state so existing tests keep
  // exercising the same caches the live server uses.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(_singletonState(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(_singletonState())
  }
}

// Why: ergonomic accessor so the `_internals` shim can reach the singleton's
// per-instance state without exposing `state` on the public class surface.
function _singletonState(): HookListenerState {
  // The runtime field is private, but tests access this module exclusively
  // through `_internals`, which only fires after the module-level
  // `agentHookServer` is constructed. The cast keeps the compile-time
  // private invariant intact.
  return (agentHookServer as unknown as { state: HookListenerState }).state
}
