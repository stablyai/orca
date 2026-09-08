# TDD-AG-04: Handshake & Session Management

**Document:** TDD-AG-04
**Version:** 2.0
**Date:** 2026-07-28
**Domain:** Handshake protocol, session lifecycle, lastConnHandshakeOk tracking
**Source:** `src/relay/agent-session.ts` — `sendHandshake()`, `createSession()` in agent-session.ts
**HLD Ref:** C3.8
**ADR:** ADR-005

---

## 1. Handshake Request (Agent → Orca)

```javascript
function sendHandshake(ws, token) {
  const rpc = {
    jsonrpc: '2.0',
    id: 1,
    method: 'agent.handshake',
    params: {
      agentToken:   token,        // AGENT_TOKEN env var
      devServerId:  DEV_ID,       // DEV_SERVER_ID env var
      capabilities: ['rpc', 'tools'],
      tools:        discoveredTools.map(t => t.name), // e.g. ['claude_code', 'git', 'gh', ...]
      version:      '1.0.0',
    },
  };
  ws.send(encodeFrame(FRAME_TYPE.HANDSHAKE, JSON.stringify(rpc)));
}
```

**Sent on `ws.on('open')`** — immediately after WebSocket connects.

---

## 2. Handshake Response (Orca → Agent)

```json
// Success:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "ok",
    "sessionId": "sess-xxxxxxxx"
  }
}

// Failure (token rejected/expired):
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": 1008,
    "message": "Invalid or expired agent token"
  }
}
```

---

## 3. lastConnHandshakeOk Flag

```javascript
let lastConnHandshakeOk = false;

// In handleSession():
if (rpc.result?.status === 'ok') {
  handshakeDone = true;
  lastConnHandshakeOk = true;
  log.info(`Handshake OK: sessionId=${rpc.result.sessionId}`);
} else if (rpc.error) {
  log.error(`Handshake failed: ${JSON.stringify(rpc.error)}`);
  ws.close(1008, 'Handshake failed');
}

// In connectDirect() close handler:
if (lastConnHandshakeOk) {
  log.warn(`Connection dropped after handshake → exit(2) for fresh token restart`);
} else {
  log.error(`Connection closed before handshake → token rejected/expired → exit(2)`);
}
```

**Mục đích:** Distinguish giữa:
- Pre-handshake close: token bị reject → log error
- Post-handshake close: network drop → log warn

Cả hai đều exit(2) để systemd restart với token mới.

---

## 4. Session Lifecycle

| Phase | Description |
|-------|-------------|
| Pre-connect | `seqCounter=0`, `highestAck=0` reset |
| ws.open | `sendHandshake()` + `startKeepalive()` |
| Handshaking | Only process response với `id=1` (handshake reply) |
| Session active | `handshakeDone=true` → `dispatchRpc()` for all subsequent frames |
| ws.close code=1000 | Clean close → `exit(0)` |
| ws.close code≠1000 | Unexpected → `exit(2)` after 200ms delay |
| SIGTERM | `exit(0)` |

---

## 5. Handshake Timeout (Server Side)

Orca Server: `AgentWebSocketServer` có handshake timeout 20s (ADR-005).
- Nếu agent không gửi `agent.handshake` trong 20s → server closes connection
- Frame TYPE phải = `0x01` (Regular) → non-Regular frames SILENTLY IGNORED → timeout

---

## 6. Tools Advertisement trong Handshake

Agent gửi danh sách tools hiện có trong handshake:
```javascript
tools: discoveredTools.map(t => t.name)
// Ví dụ: ['claude_code', 'claude_code_file', 'gh', 'git', 'gitnexus', 'codegraph', 'docker', 'shell', 'read_file', 'list_dir']
```

Orca Server lưu danh sách này vào `DevServerManager` → UI hiển thị tools available cho dev server.

Khi server gọi `tools/list` → agent trả lại danh sách đầy đủ với `inputSchema`.

---

## 7. Capabilities Advertisement — Addendum (2026-08-03)

**Status: ✅ IMPLEMENTED** — `src/relay/agent-session.ts`'s `buildCapabilities()`

Two capabilities were added to the handshake's `capabilities` list:

| Capability | Gated by | Meaning |
|------------|----------|---------|
| `fs.watch` | none — always advertised | The agent binary is new enough to support `fs.watch`/`fs.unwatch` (TDD-AG-07 §9.3). Unconditional because, unlike PTY, it has no native-module dependency — it's purely about binary freshness, not host support. |
| `pty.stream` | `checkPtyAvailable()` (same gate as `pty`) | The agent will also push live `pty.data`/`pty.exit` notifications (TDD-AG-07 §9.2), not just respond to `pty.create`/`pty.write`/etc. Kept as a separate string from `pty` so Orca can distinguish an old agent binary (`pty` only, request/response polling via `pty.scrollback`) from a new one (`pty` + `pty.stream`) — in practice the two are almost always both-or-neither, since both depend on the same `node-pty` availability and this session's code being deployed.

```typescript
// src/relay/agent-session.ts
async function buildCapabilities(): Promise<readonly string[]> {
  const caps: string[] = ['fs', 'fs.watch', 'preflight', 'ai.providers', 'agent.spawn', 'agent.exec', 'agent.sendInput', 'agent.kill']
  const [hasGit, hasPty] = await Promise.all([checkGitAvailable(), checkPtyAvailable()])
  if (hasGit) caps.push('git', 'git.exec', 'git.execStream', 'worktrees', 'git.worktree.list', 'git.worktree.add', 'git.worktree.remove')
  if (hasPty) caps.push('pty', 'pty.create', 'pty.write', 'pty.resize', 'pty.destroy', 'pty.scrollback', 'pty.stream')
  return caps
}
```

`STATIC_CAPABILITIES_FALLBACK` (used only when the 5s capability-check race in `sendHandshake()` times out) was deliberately **not** updated to include `fs.watch`/`pty.stream` — a slow/uncertain check should conservatively report the older, narrower surface rather than promise streaming it can't confirm.

**Known doc/type gap:** `AgentCapability` in `src/shared/agent-wire-protocol.ts` (see TDD-AG-02 §1) is typed as `'pty' | 'fs' | 'git' | 'preflight'` — a 4-value union that was already stale before this session (`buildCapabilities()` has long returned a plain `string[]` with many more values, e.g. `agent.spawn`, `worktrees`, `git.execStream`). This addendum does not fix that type; flagging it here so it isn't mistaken for an authoritative capability list.

---

## 8. Session Cleanup on `stop()` — Addendum (2026-08-03)

**Status: ✅ IMPLEMENTED**

`stop()` previously only cleared the keepalive timer and called `cleanupAllPtys(log)` (from `agent-spawner.ts` — kills `agent.spawn`-launched AI-agent PTYs, a different concern from terminal PTYs). Two calls were added, both fixing resources that would otherwise outlive a dropped WebSocket:

```typescript
stop(): void {
  if (keepaliveTimer !== null) { clearInterval(keepaliveTimer); keepaliveTimer = null }
  cleanupAllPtys(log)        // agent-spawner.ts — AI-agent CLI PTYs (unchanged, TDD-AG-12)
  cleanupAgentPtys(log)      // pty-agent-bridge.ts — terminal (pty.create) PTYs (NEW wiring)
  cleanupAgentWatches()      // fs-agent-extensions.ts — fs.watch watchers (NEW wiring)
}
```

`cleanupAgentPtys()` was pre-existing (documented in its own file header as "must be called on session termination") but had never actually been wired into `stop()` — a dormant bug. `cleanupAgentWatches()` is new alongside `fs.watch` itself. See TDD-AG-07 §9 for what each cleans up.


---

## 9. Addendum (2026-09-07) - Sections 3-4's lastConnHandshakeOk -> exit(2) narrative is superseded

**Status: describes OUTDATED behavior - corrected here, per TASK-AG-STORAGE-004.**

Sections 3 and 4 above describe both a pre-handshake close and a
post-handshake close ending in `exit(2)` "for fresh token restart" (relying
on systemd `Restart=always`). Reading the real, current
`agent/src/relay/agent-connection-direct.ts` shows this is no longer how
the agent behaves - see TDD-AG-03 (`03-connection-modes.md`) section 6's
addendum for the full corrected code. Summary as it applies here:

- A close **before** handshake completes (`lastHandshakeOk === false`,
  matching this doc's `lastConnHandshakeOk` flag) now resolves to
  `'reconnect-auth-failed'` in the real code - the agent calls
  `tokenManager.forceRenew()` and retries the connection with backoff, it
  does not exit.
- A close **after** a successful handshake resolves to `'reconnect-renew'`
  - same outcome: force-renew the token if a manager is configured, then
    reconnect with backoff. Also does not exit.
- The only paths that end the process are a clean `code===1000` close
  (`exit(0)`) and `SIGINT`/`SIGTERM`.

The Session Lifecycle table in section 4 should be read with this
correction: every "Unexpected -> exit(2) after 200ms delay" row now reads
as "Unexpected -> force-renew token if needed, reconnect after backoff
(`RECONNECT_DELAYS_MS`), stay in the same process."

This addendum does not change the handshake request/response shapes,
`lastConnHandshakeOk`'s bookkeeping role, or sections 5-8 above (tools
advertisement, capabilities, session cleanup on `stop()`) - only the
"what happens after a close" narrative in sections 3-4 needed correcting.
See
`specs/agent/crs/v3/storage/solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md`
section 2 for the investigation, and
`specs/agent/crs/v3/storage/solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md`
for why the distinction matters for CR-STORAGE-008(b) (the transport layer
already reconnects; the remaining gap is whether in-flight work on the
dev server survives the gap).
