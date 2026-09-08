# TDD-AG-03: Connection Modes (v2.1 — TypeScript)

**Document:** TDD-AG-03
**Version:** 2.1
**Date:** 2026-07-28
**Source files:**
- `src/relay/agent-connection-direct.ts` ← [NEW]
- `src/relay/agent-connection-relay.ts` ← [NEW]
- `src/relay/agent-session.ts` ← [NEW]
**HLD Ref:** C3.8
**ADR:** ADR-004

---

## 1. agent-connection-direct.ts

```typescript
// src/relay/agent-connection-direct.ts

import WebSocket from 'ws'
import { AgentConfig } from './agent-config'
import { ToolDefinition } from './agent-tool-registry'
import { createSession } from './agent-session'
import { AgentLogger } from './agent-logger'

export async function connectDirect(
  config: AgentConfig,
  tools: ToolDefinition[],
  log: AgentLogger
): Promise<never> {
  if (!config.agentToken) {
    log.error('AGENT_TOKEN required for direct-websocket mode')
    log.error('Run:  bash deploy/dev/scripts/connect-agent.sh')
    process.exit(1)
  }

  let lastHandshakeOk = false

  const ws = new WebSocket(config.orcaUrl, {
    headers: { 'User-Agent': 'orca-dev-agent/2.1.0' },
    rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
  })

  const session = createSession(config, tools, log)

  ws.once('open', () => {
    log.info(`WebSocket connected: ${config.orcaUrl}`)
    session.start(ws)
    session.onHandshakeOk(() => { lastHandshakeOk = true })
  })

  ws.once('close', (code) => {
    session.stop()
    if (code === 1000) {
      log.info('Connection closed cleanly (code=1000). Shutting down.')
      process.exit(0)
    }
    if (lastHandshakeOk) {
      log.warn(`Connection dropped after handshake (code=${code}) — exiting for systemd restart`)
    } else {
      log.error(`Connection closed before handshake (code=${code}) — token rejected/expired`)
    }
    // DO NOT retry: token is one-time use. systemd Restart=always + start.sh fetches new token.
    setTimeout(() => process.exit(2), 200)
  })

  ws.on('error', (err) => log.error(`WS error: ${err.message}`))

  // Never resolves — process runs until exit()
  return new Promise<never>(() => {})
}
```

---

## 2. agent-connection-relay.ts

```typescript
// src/relay/agent-connection-relay.ts

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { AgentConfig } from './agent-config'
import { ToolDefinition } from './agent-tool-registry'
import { createSession } from './agent-session'
import { AgentLogger } from './agent-logger'

export async function listenRelay(
  config: AgentConfig,
  tools: ToolDefinition[],
  log: AgentLogger
): Promise<never> {
  const token = config.agentToken || 'relay-secret'

  return new Promise<never>((_, reject) => {
    const wss = new WebSocketServer({ port: config.agentPort, path: '/orca-relay' })

    wss.once('listening', () => {
      log.info(`✅ Ready: ws://0.0.0.0:${config.agentPort}/orca-relay`)
      log.info(`In Orca UI: Type=relay-websocket  URL=ws://${config.devServerId}:${config.agentPort}/orca-relay?token=${token}`)
    })

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (!authenticate(ws, req, token, log)) return

      log.info(`Orca connected from ${req.socket.remoteAddress}`)
      const session = createSession(config, tools, log)
      session.start(ws)

      ws.once('close', () => session.stop())
    })

    wss.once('error', (err) => {
      log.error(`Server error: ${err.message}`)
      reject(err)
    })
  })
}

function authenticate(
  ws: WebSocket,
  req: IncomingMessage,
  expectedToken: string,
  log: AgentLogger
): boolean {
  const url = new URL(`ws://localhost${req.url ?? ''}`)
  const qToken = url.searchParams.get('token') ?? ''
  const bToken = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '')
  const incoming = qToken || bToken

  if (incoming !== expectedToken) {
    log.warn(`Rejected unauthorized connection from ${req.socket.remoteAddress}`)
    ws.close(1008, 'Unauthorized')
    return false
  }
  return true
}
```

---

## 3. agent-session.ts — Session Handler

```typescript
// src/relay/agent-session.ts

import WebSocket from 'ws'
import { AgentConfig } from './agent-config'
import { ToolDefinition } from './agent-tool-registry'
import { AgentLogger } from './agent-logger'
import { createWireState, decodeFrame, encodeDataFrame, encodeKeepaliveFrame, parseJsonPayload } from './agent-wire'
import { createRpcDispatcher } from './agent-rpc-dispatch'
import { AGENT_HANDSHAKE_METHOD, AGENT_KEEPALIVE_INTERVAL_MS } from '../shared/agent-wire-protocol'
import { MessageType } from '../main/ssh/relay-protocol'

export interface AgentSession {
  start(ws: WebSocket): void
  stop(): void
  onHandshakeOk(callback: () => void): void
}

export function createSession(
  config: AgentConfig,
  tools: ToolDefinition[],
  log: AgentLogger
): AgentSession {
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let handshakeDone = false
  let handshakeOkCallbacks: Array<() => void> = []
  const dispatcher = createRpcDispatcher(tools, config, log)

  function sendHandshake(ws: WebSocket): void {
    const rpc = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: AGENT_HANDSHAKE_METHOD,
      params: {
        agentVersion:  '2.1.0',
        platform:      process.platform,
        arch:          process.arch,
        nodeVersion:   process.version,
        capabilities:  ['fs', 'git', 'preflight'],
        agentToken:    config.agentToken || undefined,
        devServerId:   config.devServerId,
        tools:         tools.map(t => t.name),
      },
    }
    const state = createWireState()
    ws.send(encodeDataFrame(state, JSON.stringify(rpc)))
    log.info(`Sent handshake: devServerId=${config.devServerId}, tools=[${tools.map(t => t.name).join(',')}]`)
  }

  function startKeepalive(ws: WebSocket, wireState: ReturnType<typeof createWireState>): void {
    keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeKeepaliveFrame(wireState))
      }
    }, AGENT_KEEPALIVE_INTERVAL_MS)
  }

  return {
    start(ws: WebSocket): void {
      const wireState = createWireState()

      ws.once('open', () => {
        log.info('Session starting')
        sendHandshake(ws)
        startKeepalive(ws, wireState)
      })

      // If ws is already open (relay-websocket: Orca called us, already connected)
      if (ws.readyState === WebSocket.OPEN) {
        sendHandshake(ws)
        startKeepalive(ws, wireState)
      }

      ws.on('message', (data: Buffer | string) => {
        if (!Buffer.isBuffer(data)) return
        const frame = decodeFrame(wireState, data)
        if (!frame) return

        if (frame.type === MessageType.KeepAlive) {
          ws.send(encodeKeepaliveFrame(wireState))
          return
        }

        if (frame.payload.length === 0) return

        const rpc = parseJsonPayload<{ id: unknown; result?: unknown; error?: unknown; method?: string }>(frame.payload)
        if (!rpc) { log.warn('Malformed JSON in frame'); return }

        if (!handshakeDone) {
          if ((rpc.result as any)?.ok === true) {
            handshakeDone = true
            log.info(`Handshake OK: sessionId=${(rpc.result as any)?.sessionId}`)
            handshakeOkCallbacks.forEach(cb => cb())
          } else if (rpc.error) {
            log.error(`Handshake failed: ${JSON.stringify(rpc.error)}`)
            ws.close(1008, 'Handshake failed')
          }
          return
        }

        // Dispatch RPC
        void dispatcher.dispatch(ws, wireState, rpc as any)
      })

      ws.on('close', (code, reason) => {
        log.info(`Session closed code=${code} reason=${reason.toString()}`)
      })

      ws.on('error', (err) => log.error(`WS error: ${err.message}`))
    },

    stop(): void {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
    },

    onHandshakeOk(callback: () => void): void {
      handshakeOkCallbacks.push(callback)
    },
  }
}
```

---

## 4. Test Coverage

```typescript
// src/relay/__tests__/agent-connection-direct.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
// Mock WebSocket, test connection logic

describe('connectDirect', () => {
  it('exits(1) when AGENT_TOKEN empty', async () => { ... })
  it('calls session.start() on ws open', () => { ... })
  it('exits(0) on ws close code=1000', () => { ... })
  it('exits(2) on unexpected close after handshake', () => { ... })
  it('exits(2) on close before handshake', () => { ... })
})

// src/relay/__tests__/agent-connection-relay.test.ts
describe('listenRelay', () => {
  it('rejects connection with wrong token → ws.close(1008)', () => { ... })
  it('accepts connection with correct token in querystring', () => { ... })
  it('accepts connection with Authorization header', () => { ... })
  it('creates session per connection (isolated)', () => { ... })
})

// src/relay/__tests__/agent-session.test.ts
describe('createSession', () => {
  it('sends handshake on start()', () => { ... })
  it('starts keepalive interval on start()', () => { ... })
  it('responds to KeepAlive frames', () => { ... })
  it('sets handshakeDone on result.ok=true', () => { ... })
  it('closes ws on handshake error', () => { ... })
  it('dispatches RPC after handshake', () => { ... })
  it('stop() clears keepalive timer', () => { ... })
})
```

**Target:** ≥ 20 tests

---

## 5. Addendum (2026-08-03) — Push Notifications Use the Same Connection

All 3 current production Dev Servers run in `direct-websocket` mode (agent-initiated outbound connection, per §1). The one-way push notifications added in TDD-AG-02 §5 / TDD-AG-07 §9 (`pty.data`, `pty.exit`, `fs.changed`) don't open a second channel or change the connection mode — they're agent-initiated frames sent over this same `ws` connection, using the same `WireState`/`encodeDataFrame` as every response. No change to `connectDirect()`, `listenRelay()`, or the mode-selection logic was needed.


---

## 6. Addendum (2026-09-07) - connectDirect's exit(2)-on-drop description is superseded by a real reconnect loop

**Status: describes OUTDATED behavior - corrected here, per TASK-AG-STORAGE-004.**

Section 1's `connectDirect()` code sample above ("DO NOT retry: token is
one-time use... `setTimeout(() => process.exit(2), 200)`") described an
earlier version. Reading the real, current
`agent/src/relay/agent-connection-direct.ts` (and the compiled
`deploy/agent/agent.js` bundle) shows the function was redesigned into an
in-process, infinite reconnect loop:

```typescript
// agent/src/relay/agent-connection-direct.ts - REAL current behavior
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000, 30000]

async function connectDirect(config, tools, log) {
  const tokenManager = config.apiSecret ? new AgentTokenManager({ /* ... */ }) : null
  if (tokenManager) await tokenManager.init()

  let reconnectAttempt = 0
  while (true) {
    const result = await runConnection()   // opens ws, sends handshake, waits for close
    if (result === 'exit') { tokenManager?.dispose(); process.exit(0); return }
    // result is 'reconnect-renew' or 'reconnect-auth-failed' for any other close code
    if (tokenManager) await tokenManager.forceRenew().catch(() => {})
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttempt += 1
    await sleep(delay)
  }
}
```

Key differences from Section 1's description:

- The process **never calls `process.exit(2)`** for a dropped connection -
  only a clean `code===1000` close (leads to `exit(0)`) or `SIGINT`/`SIGTERM`
  end the process. Every other close reconnects in the same process.
- Token renewal is proactive, not "wait for systemd to fetch a new one":
  `AgentTokenManager` (`agent/src/relay/agent-token-manager.ts`) fetches a
  token at startup and renews at 80% of its TTL before it's needed,
  holding the renewed token in memory so a drop can reconnect immediately;
  `forceRenew()` is called as a fallback if a reconnect attempt itself
  fails auth.
- Backoff is `[1000, 2000, 5000, 15000, 30000]` ms (capped at the last
  value), not systemd's restart cadence.

This does not change the wire protocol or connection-mode selection
(sections 1-3 above remain accurate for those) - only the "what happens
when the socket closes" narrative needs this correction. See
`specs/agent/crs/v3/storage/solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md`
section 2 for the investigation that found this drift, and
`specs/agent/crs/v3/storage/solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md`
for why this matters (the transport layer already reconnects reliably; the
remaining gap is whether in-flight work survives the gap, not the
connection itself).
