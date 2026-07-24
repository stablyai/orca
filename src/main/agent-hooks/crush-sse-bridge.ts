// Why: crush (charmbracelet/crush) auto-spawns a detached `crush server` when
// launched with CRUSH_CLIENT_SERVER=1. Orca launches crush with a per-pane
// custom `--host unix://...` so each agent pane owns a private crush server +
// SSE stream (see crush startDetachedServer in internal/cmd/root.go — the
// auto-spawned server inherits `--host`). This module is Orca's in-process SSE
// subscriber: it connects to the pane's socket, parses the chunked SSE stream,
// and forwards each envelope to the AgentHookServer as a synthetic hook event.

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'
import {
  crushHookEventName,
  crushHookPayload,
  parseCrushSseChunk,
  parseCrushSseEvent,
  type CrushSseEnvelope
} from '../../shared/crush-sse-shapes'

export type CrushSseBridgeDeps = {
  paneKey: string
  launchToken: string
  tabId?: string
  worktreeId?: string
  /** Called per parsed SSE envelope. Why: indirection lets tests inject a
   *  recorder without spinning up a real crush server. */
  onEvent: (args: { hookEventName: string; hookPayload: Record<string, unknown> }) => void
  /** Optional sink for unrecoverable client errors (logs in prod, assertions in tests). */
  onError?: (err: Error) => void
}

const SSE_INITIAL_BACKOFF_MS = 250
const SSE_MAX_BACKOFF_MS = 10_000
const SSE_REQUEST_TIMEOUT_MS = 0 // Why: 0 = no socket idle timeout; SSE is long-lived.

/** Resolve the per-pane socket directory crush's auto-spawned server will bind
 *  to. Match crush's server.DefaultHost socketDir() so the --host value we
 *  hand it lines up byte-for-byte with what the server actually binds. */
export function crushOrcaSocketDirectory(): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && path.isAbsolute(xdg)) {
    return xdg
  }
  return os.tmpdir()
}

/** Full filesystem path of the per-pane socket for a launchToken. */
export function crushOrcaSocketPath(launchToken: string): string {
  const safe = launchToken.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
  return path.join(crushOrcaSocketDirectory(), `crush-orca-${safe}.sock`)
}

/** `--host` value Orca passes to crush and its auto-spawned server. */
export function crushOrcaHostArg(launchToken: string): string {
  return `unix://${crushOrcaSocketPath(launchToken)}` as const
}

/** Whether the SSE bridge can run on the current platform. crush's
 *  client-server transport supports unix sockets (macOS, Linux) and Windows
 *  named pipes; Node's `http.request({ socketPath })` only supports unix
 *  sockets. Why: gate Windows out for v1 — title-scraping remains available. */
export function crushSseBridgeSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}

export type CrushSseBridge = {
  /** Stop the client and stop reconnecting. Idempotent. */
  stop: () => void
  /** True once `stop` was called. */
  stopped: () => boolean
}

export function startCrushSseBridge(socketPath: string, deps: CrushSseBridgeDeps): CrushSseBridge {
  // Why: Windows / unsupported runtimes return a no-op bridge so the caller
  // does not need to branch per-platform. The failure is logged once.
  if (!crushSseBridgeSupported()) {
    return { stop: () => {}, stopped: () => true }
  }
  let stopped = false
  let currentRequest: http.ClientRequest | null = null
  let backoff = SSE_INITIAL_BACKOFF_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let buffer = ''

  const connect = (): void => {
    if (stopped) {
      return
    }
    const req = http.request(
      {
        method: 'GET',
        socketPath,
        path: '/v1/workspaces/0/events',
        headers: { Accept: 'text/event-stream' },
        timeout: SSE_REQUEST_TIMEOUT_MS
      },
      (res) => {
        // Why: crush returns 404/no-body if the server hasn't finished booting;
        // schedule a reconnect instead of treating a partial response as fatal.
        if (res.statusCode !== 200) {
          res.resume()
          scheduleReconnect()
          return
        }
        // Why: success — reset backoff so the next retry-after-drop starts fresh.
        backoff = SSE_INITIAL_BACKOFF_MS
        let pending = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          pending += chunk
          const parsed = parseCrushSseChunk(buffer, pending)
          buffer = parsed.rest
          pending = ''
          for (const ev of parsed.events) {
            dispatch(ev)
          }
        })
        res.on('end', () => scheduleReconnect())
        res.on('error', () => scheduleReconnect())
      }
    )
    req.on('error', () => scheduleReconnect())
    currentRequest = req
    req.end()
  }

  const dispatch = (ev: { data: string }): void => {
    const envelope = parseCrushSseEvent(ev)
    if (!envelope) {
      return
    }
    forward(envelope)
  }

  const forward = (envelope: CrushSseEnvelope): void => {
    const hookEventName = crushHookEventName(envelope)
    if (!hookEventName) {
      return
    }
    const hookPayload = crushHookPayload(envelope)
    try {
      deps.onEvent({ hookEventName, hookPayload })
    } catch (err) {
      // Why: the sink (AgentHookServer.submitSyntheticHookEvent) is itself
      // guarded, but wrap once more so a throwing observer can't kill the loop.
      deps.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped) {
      return
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }
    currentRequest?.destroy()
    currentRequest = null
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      backoff = Math.min(backoff * 2, SSE_MAX_BACKOFF_MS)
      connect()
    }, backoff)
    if (typeof reconnectTimer.unref === 'function') {
      reconnectTimer.unref()
    }
  }

  connect()

  return {
    stop: () => {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      currentRequest?.destroy()
      currentRequest = null
    },
    stopped: () => stopped
  }
}

/** Re-exported for tests that need to assert the URL form. */
export { URL }
