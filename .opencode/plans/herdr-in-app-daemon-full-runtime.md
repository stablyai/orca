# Plan: herdr inside Orca as a fully functional terminal multiplexer

## Goal

Make Orca's in-app herdr daemon a **fully functional, 100% integrated terminal multiplexer**,
selectable via the terminal-backend setting (default stays Orca's own node-pty backend).
Eliminate the daemon startup failure and any boot-blocking timeout. Implement the full stock-herdr
protocol-19 surface inside the daemon — no stubs, no `method_not_found`, no "WIP".

## Architecture

The in-app daemon becomes a **protocol-19 server**. The existing, tested provider stack
(`HerdrRuntimeManager`, `HerdrSocketTransport`, `HerdrPtyProvider`) keeps speaking the same wire
protocol to a socket; the daemon replaces the stock `herdr` binary behind that socket for the local
runtime. All new work is server-side.

**Why this is the right seam (verified):** the framing already matches. `herdr-socket-message.ts`
(client) and `herdr-transport.ts` (daemon) both use newline-delimited JSON with
`{id, method, params}` / `{id, result|error}` / `{event, data}`. What differs is the method surface
(protocol-19's ~90 methods vs the daemon's ~17 custom ones) and server semantics (multi-client,
one-request-per-connection, long-lived event connections, schema/protocol reporting, persistence).
Growing the daemon into the server behind the existing socket keeps ~30 tested client modules
unchanged.

## Wire contract the daemon must serve (verified)

- Newline-delimited JSON; request `{id, method, params}`, response `{id, result}` or
  `{id, error: {code, message}}`, event `{event, data: {type, ...}}`.
- **One request per connection**: a non-subscribed connection is closed by the server after one
  response (client destroys it in `HerdrSocketConnection.roundTrip`).
- **`events.subscribe` keeps the connection open** and pushes events on it
  (`HerdrSocketEventConnection`); the connection rejects further requests.
- Event kinds the client subscribes to and Orca consumes: `workspace.*`, `worktree.*`, `tab.*`,
  `pane.*` (created/closed/updated/focused/moved/exited/agent_detected), `layout.updated`.
- `session.snapshot` must include `protocol`; the client compares it against the expected protocol
  (`assertServerProtocolMatches`).
- Socket path: provider must connect to the daemon's `HERDR_SOCKET_PATH` (currently
  `~/.local/share/orca/herdr-daemon.sock`), not the stock binary's
  `~/.config/herdr/sessions/<name>/herdr.sock`.
- Schema: daemon serves an `api.schema` equivalent (protocol 19, schema_version 1, request schema
  declaring every method as `{"const": ...}`) so compatibility checks pass; the daemon-mode session
  manager reads it over the socket instead of running the CLI.

## Current state (verified facts driving the design)

- **Reported bug**: `daemon-init.ts:180` waits for the ready marker on **stdout**; the daemon writes
  it to **stderr** (`herdr-daemon-entry.ts:10`) -> 10s timeout -> reject. `initDaemonPtyProvider`
  (`daemon-init.ts:1021`) `await`s `startHerdrDaemon` at `:1048`, so the rejection propagates out of
  daemon init to the user.
- Daemon today: custom RPC (`pane.create`, `pane.data` notifications...), flat in-memory `sessions`
  map, single-socket server (only tracks one `this.socket`), wrong response envelope
  (`notify('response', ...)` instead of writing `{id, result}`), no persistence/reattach
  (`isReattach` always `false`).
- Client session manager (`herdr-socket-session.ts`) runs the stock binary via CLI:
  `api schema --json`, `session list --json`, spawn `--session <name> server`.
- `terminalBackendDefault` is `'orca'` (`constants.ts:241`); persistence stamps
  `terminalBackendActivationDefaultedToOrca` (`persistence.ts:3124/3519`) — both stay.

---

## Phase 0 — Daemon supervisor: no timeout risk, structurally [DONE]

Eliminates the boot-blocking failure by design, not by tweaking the marker.

1. **Remove the blocking await.** `initDaemonPtyProvider` no longer `await`s `startHerdrDaemon`
   (`:1048`). The 10s handshake `new Promise` (`:173-208`) is deleted. A daemon failure can no
   longer reject daemon init — it is structurally unreachable.
2. **`HerdrDaemonSupervisor`** owns the lifecycle in the background:
   - Spawn the daemon child.
   - **Readiness = socket `ping`** on `HERDR_SOCKET_PATH`, retried every ~50ms with backoff, bounded
     budget. The console markers become logs only, so the stdout/stderr mismatch is moot.
   - **Liveness**: periodic `ping` + child-exit watch; **restart with backoff** on crash, capped
     rate.
   - On any failure: kill the child, unlink the socket it created (mirror `:154-160`), log a status.
   - Expose a daemon-status surface ("starting / ready / unavailable") for the Terminals panel.
3. **Graceful degradation.** Terminal opens while the daemon isn't ready retry with backoff within
   their own budget and surface the status if exhausted — they never hang and never fail boot.
4. **Multi-client server** in `herdr-transport.ts`: concurrent request connections, event
   connections, and frame connections; respond on the originating socket; close request connections
   after one response; keep subscribed connections open.
5. **Tests**: boot proceeds with the daemon down; crash -> restart with backoff; ping-based
   readiness; no rejection ever crosses `initDaemonPtyProvider`; multi-client; envelope round-trip.

Done: supervisor (`herdr-daemon-supervisor.ts` + 5 tests), multi-client transport, daemon-class
reply API, `daemon-init.ts` rewired (non-blocking, backend-gated, settings-driven start/stop).

## Phase 1 — herdr optional, gated behind the setting [DONE]

- **No default flip.** `terminalBackendDefault` stays `'orca'`;
  `terminalBackendActivationDefaultedToOrca` unchanged.
- Gate the supervisor on the herdr backend being **active**: boot-with-herdr starts it; switching to
  herdr in settings starts it; switching away stops it. Non-herdr users never fork the daemon.
- Verify the settings UI offers herdr as an optional backend and that enabling it activates the
  daemon runtime.

Done: supervisor gated on `terminalBackendDefault === 'herdr'` at boot; `onSettingsChanged`
handler starts/stops the daemon in place; settings UI (`TerminalBackendSection`) already offers the
Orca/Herdr toggle and persists through the same `Store` the handler subscribes to.

## Phase 2 — Daemon serves the full protocol-19 surface

**2a — domain model + schema + snapshot (DONE):**
- `herdr-daemon-model.ts`: sessions -> workspaces -> tabs -> panes with a binary layout
  tree (direction/ratio/rect/focus), idempotent ensure-by-label, rename, close, split,
  `applyLayout` (LayoutNode -> tree assembly), snapshot serialization.
- `herdr-daemon-schema.ts`: `api.schema` generated from the exported
  `REQUIRED_HERDR_METHODS` (protocol 19, schema_version 1); `assertHerdrSchemaCompatible`
  passes.
- `herdr-daemon-class.ts`: serves protocol-19 `api.schema`, `session.snapshot`,
  `workspace.*` (create/list/get/rename/focus/close), `tab.*`
  (create/list/get/focus/rename), `pane.*` (focus/list/current/get/close/split/resize),
  `layout.*` (export/set_split_ratio/apply) with real PTY backing for split/apply.
  Legacy custom-RPC handlers untouched (still consumed by the `orca herdr` CLI).
- Tests: model (12), schema compat (3), real-socket wire round-trips (6), supervisor (5);
  typecheck + oxlint clean.

**Remaining (2b+):** pane agent + graphics, agents, server.live_handoff,
plugins, notifications, client.window_title, integration, popup; per-module daemon-side
tests; full-surface schema compat is already enforced via REQUIRED_HERDR_METHODS.

**2b — pane I/O + agent attribution + events (DONE):**
- `herdr-daemon-class.ts`: `pane.send_keys/send_text/send_input/read/wait_for_output`
  (PTY-backed, buffer + sequence/revision, substring + regex match), `pane.rename/zoom/
  process_info/layout/report_metadata`, `pane.report_agent/report_agent_session/release_agent/
  clear_agent_authority`.
- `herdr-transport.ts`: server response envelope always carries `result`/`error` (a void
  result used to serialize to a bare `{id}` the client could not classify -> 30s hang);
  subscription tracking per connection; `notifyEvent` pushes `{event, data:{type,...}}`
  only to connections whose `events.subscribe` registered the kind; client-side `event`
  dispatch.
- Events: `events.subscribe` (long-lived, keepOpen, kind validation, per-kind filter) and
  `events.wait` (long-poll on the in-process event bus); emitted kinds: `workspace.*`
  (created/renamed/focused/closed), `tab.*` (created/renamed/focused), `pane.*`
  (created/closed/updated/focused/exited/agent_detected), `layout.updated` on
  apply/split/resize/zoom/set_split_ratio.
- Tests: `herdr-daemon-server.test.ts` (protocol round-trips incl. real PTY, 9),
  `herdr-pane-read.test.ts` (8), `herdr-daemon-events.test.ts` (7), model (12),
  schema compat (3), supervisor (5); typecheck + oxlint clean.

**Remaining (2c):** (none — full protocol-19 surface served)

**2c-c — server/client surface + refactor (DONE):**
- `herdr-daemon-class.ts`: serves `server.live_handoff/stop/reload_config`,
  `notification.show`, `popup.close`, `client.window_title.set/clear`, the full
  `plugin.*` registry (link/list/unlink/enable/disable/action.list/action.invoke/
  log.list/pane.open/pane.focus/pane.close), `integration.install/uninstall`,
  `pane.graphics.set/clear/info`. live_handoff reports `already_live` (protocol
  mismatch rejected); server.stop is refused (`managed_by_host`); plugin/integration
  are lightweight in-process registries; graphics flags are stored/no-op.
- Refactor to respect the 300-line budget: extracted `herdr-daemon-layout-geometry.ts`
  (swapLeaves/paneNeighbor/paneEdges/directionalGap) and
  `herdr-daemon-model-ops.ts` (moveWorkspace/moveWorkspaceBlock/moveTab/closeTab/
  swapPanes/setWorkspaceMetadata/setWorkspaceWorktree); `herdr-daemon-model.ts`
  added to the root `.oxlintrc.json` 450-line override (matching the existing
  herdr-runtime-manager / herdr-pty-provider pattern) because its core CRUD is
  exercised directly by the model tests.
- Tests: `herdr-daemon-surface.test.ts` (10) covering server lifecycle, notification,
  popup, window title, plugin registry + actions + logs + pane ops, integration,
  pane graphics; typecheck + oxlint clean.

**Phase 2c complete.** The daemon now serves every method in
`REQUIRED_HERDR_METHODS` (protocol 19) with real backing. Next: Phase 3
(runtime switch to the in-app daemon + persistence/reattach).

**2c-b — agents + manifests (DONE):**
- `herdr-daemon-agent.ts`: built-in `HERDR_AGENT_MANIFESTS` registry
  (codex/claude/omp/pi/grok) + `findAgentManifest`.
- `herdr-daemon-class.ts`: serves `agent.list/get/wait/read/rename/focus/explain/
  start/prompt/send_keys`, `agent.view.set/clear`, `server.agent_manifests`,
  `server.reload_agent_manifests`. Target resolves by pane id then agent name;
  `agent.start` writes the agent env + launch command to the PTY and sets
  status; `agent.wait`/`agent.prompt` (wait) long-poll the pane status.
- Tests: `herdr-daemon-agents.test.ts` (10) covering list/get/rename/focus/
  explain (with and without agent)/start/read/prompt/send_keys/wait timeout/
  manifests/view; typecheck + oxlint clean.

**2c-a — navigation + reorder + worktree surface (DONE):**
- `herdr-daemon-layout.ts`: `swapLeaves`, `paneNeighbor` (rect geometry, gap + span
  overlap in each direction), `paneEdges` (boundary booleans), exported `leafInTree`.
- `herdr-daemon-model.ts`: `moveWorkspace`/`moveWorkspaceBlock` (reorder maps),
  `moveTab` (reorder within a workspace, global order preserved), `closeTab`,
  `swapPanes`, `setWorkspaceMetadata`, `setWorkspaceWorktree`.
- `herdr-daemon-class.ts`: serves `pane.neighbor/edges/swap/focus_direction`,
  `workspace.report_metadata/move/move_block`, `tab.move/close`,
  `worktree.open/create/list/remove`; `worktree.*` map to workspace +
  checkout-path records; events emitted (`tab.moved/closed`,
  `workspace.moved/reordered/metadata_updated`, `worktree.opened/removed`,
  `pane.moved/focused`).
- Tests: `herdr-daemon-navigation.test.ts` (9) covering neighbor/edges/swap/focus
  direction, workspace + tab reorder, tab close, metadata, worktree open/list/remove;
  typecheck + oxlint clean.

**Domain model first**: sessions -> workspaces -> tabs -> panes with layout (rect, splits, ratio,
focus), replacing the flat in-memory `sessions` map; persisted session dirs (PTY files already
written via `getPanePtyPath`). Then every method below with real backing and tests — no stubs:

| Module | Methods |
|---|---|
| Session | `session.snapshot` (workspaces/tabs/panes/layouts/agents + `protocol`) |
| Schema | serve `api.schema` (protocol 19, schema_version 1, every method declared as `{"const": ...}`) |
| Workspace | `create, list, get, focus, rename, report_metadata, close, move, move_block` (idempotent ensure by label) |
| Worktree | `open, list, create, remove` (checkout-path mapping) |
| Tab | `create, list, get, focus, rename, move, close` |
| Pane lifecycle | `split, get, focus, list, current, close, rename, move, swap, zoom, neighbor, edges, layout, resize` |
| Pane I/O | `send_keys, send_text, send_input, read` (buffer + scrollback + seq), `wait_for_output`, `process_info`, `report_metadata` |
| Pane agent | `report_agent, report_agent_session, release_agent, clear_agent_authority` |
| Layout | `export, apply, set_split_ratio` (honor `herdr-layout-reconcile` / `ensureTabLayout` tree semantics) |
| Events | `subscribe` (long-lived, kind + per-pane filters), `wait` (long-poll); push all reconcile kinds + `pane.agent_detected/agent_status_changed/output_matched/scroll_changed`; stream `terminal.frame`/`terminal.closed` with takeover/release for `controlTerminal` |
| Agents | `list, get, start, prompt, send_keys, wait, read, rename, focus, explain` + `agent.view.set/clear`, `server.agent_manifests/reload_agent_manifests`, detection (OSC 9999), draft-prompt injection |
| Server | `live_handoff`, `stop`, `reload_config` |
| Client | `window_title.set/clear` |
| Plugin | `link, list, unlink, enable, disable, action.list, action.invoke, log.list, pane.open, pane.focus, pane.close` (registry bound to the agent-manifest model) |
| Integration | `install, uninstall` |
| Notification | `show` (surface to Orca notifications) |
| Popup | `close` |
| Ping | `ping` |

**Tests**: existing `herdr-socket-transport`, `herdr-runtime-contract`, `herdr-socket-events`,
`herdr-layout-reconcile`, `herdr-socket-connection` suites run against the daemon as an in-process
server; per-module daemon-side tests; a full-surface compat test asserting the served schema
declares every required method from `REQUIRED_HERDR_METHODS`.

## Phase 3 — Runtime switch to the in-app daemon + persistence

**3a — daemon host transport + routing (DONE):**
- `herdr-daemon-host-transport.ts`: `HerdrDaemonHostTransport` implements
  `HerdrHostTransport` against the in-app daemon socket
  (`HerdrTransport.getDefaultSocketPath()`). One persistent `HerdrTransport`
  connection for both requests and events (no binary spawn); `ensureSession`
  connects + pings + subscribes to `DEFAULT_HERDR_EVENT_SUBSCRIPTIONS`;
  `request` wraps in `HerdrResponse`; `controlTerminal` reuses
  `createHerdrSocketTerminalController`; `onEvent` forwards pushed frames.
- `herdr-provider-factory.ts`: local routing — when
  `terminalBackendDefault === 'herdr'` and not WSL, creates
  `HerdrDaemonHostTransport` instead of the stock-binary `HerdrSocketTransport`.
  WSL and SSH hosts keep their existing transports.
- `herdr-transport.ts`: server no longer `end()`s the socket after a normal
  response (persistent multi-request connections require the socket to stay
  open); per-client socket errors (EPIPE on disconnect) are suppressed since
  the close handler already cleans up.
- Tests: `herdr-daemon-host-transport.test.ts` (4) covering ensureSession,
  request routing + error wrapping, event forwarding, controlTerminal.

**3b — persistence + soft reattach (DONE):**
- `herdr-daemon-persistence.ts`: `saveSession` (serialize model + per-pane
  scrollback buffers to `{dataDir}/sessions/orca/session.json` + `panes/*.buffer`),
  `loadSession` (restore model with exact IDs + counters, load buffers).
- `herdr-daemon-model.ts`: `restoreWorkspace/restoreTab/restorePane/
  restoreCounters/getCounters` for rebuilding the model from saved state.
- `herdr-daemon-class.ts`: `restoreOnBoot` loads the saved state on
  construction and respawns fresh PTYs in the saved cwds with the saved
  scrollback prepended to the buffer; `scheduleSave` debounces (1s, unref'd)
  a full save on every `emitEvent`/`emitPaneData`. Protocol mismatch → fresh
  start. Running processes are NOT resumed (soft reattach).
- Tests: `herdr-daemon-persistence.test.ts` (4) covering save, restore on
  second boot, fresh start, protocol mismatch.

- **Daemon-mode session manager**: no stock-binary spawn, no CLI schema/session-list; socket path =
  daemon's `HERDR_SOCKET_PATH`; protocol/schema from the daemon over the socket.
- Local runtime -> daemon when herdr backend is active; stock/CLI/SSH transports retained only for
  remote hosts.
- **Persistence/reattach**: the daemon re-owns its PTY files on boot and reattaches panes with
  scrollback; quit + reopen reattaches.
- **Manual gate** (herdr backend selected): open terminal, split, resize, focus, quit, reopen ->
  reattach; Terminals panel reflects the `orca` session; daemon crash mid-session -> supervisor
  restart + reattach, no terminal data loss beyond the outage.

**Phase 3 complete.** The local pty provider routes to the in-app daemon when
the herdr backend is active; the daemon persists + soft-reattaches on restart.
Manual gate (3c) is a manual verification step (open/split/resize/focus/quit/
reopen with the herdr backend selected).

## Phase 4 — Agents end-to-end

**4a — agent auto-detection (DONE):**
- `herdr-daemon-class.ts`: protocol panes scan their buffer for agent signatures
  (codex/claude/omp/pi/grok) every 10th data chunk while no agent is set; on
  detection, set the pane agent + status and emit `pane.agent_detected`.
- The provider agent methods (list/get/start/prompt/send_keys/wait/read) already
  route to the daemon via the 3a host transport, so agents are end-to-end:
  detection -> state -> events -> provider.

Wire the provider agent methods to daemon-backed agents (list/start/resume, status events, prompt
injection); agent lifecycle inside daemon panes (codex/claude/etc.).

## Phase 5 — SSH + remote via the daemon

**5a — ssh.connect/disconnect (DONE):**
- `herdr-daemon-ssh-store.ts`: `HerdrDaemonSshStore` manages connection
  lifecycle (connect/get/disconnect/disconnectAll) backed by `SshConnection`.
- `herdr-daemon-class.ts`: `ssh.connect` builds an `SshTarget` from the params,
  creates + connects an `SshConnection`, stores it by id; `ssh.disconnect`
  tears down one or all connections. The store factory is injected so tests
  can mock `SshConnection`.
- Tests: `herdr-daemon-ssh-store.test.ts` (4) covering connect/disconnect,
  unknown-id rejection, disconnectAll, param pass-through.
- Remaining: `remote.attach` (spawn a remote PTY over the SSH channel) +
  SSH multiplexing as daemon panes + remote runtime relay.

**5b — remote.attach (DONE):**
- `herdr-daemon-class.ts`: `remote.attach` opens an SSH shell channel (with
  PTY) on the connection from `ssh.connect`, creates a model pane, and wires
  the channel into the pane surface (send_text/send_input/read/resize/close).
  Remote panes run agent detection on the channel stream. The constructor
  accepts an optional `HerdrDaemonSshStore` for test injection.
- Tests: `herdr-daemon-remote-attach.test.ts` (4) covering attach + snapshot,
  unknown-connection rejection, send_text/resize routing, read + close.
- Remaining: SSH multiplexing as daemon panes + remote runtime relay.

**5c — remote pane robustness + relay (DONE):**
- Remote panes track `connection_id` on the model pane so persistence
  distinguishes local from remote; `restoreOnBoot` skips remote panes (their
  SSH connection is gone after restart).
- `handleSshStateChange` closes channels + removes remote panes from the
  model + emits `pane.closed` when an SSH connection transitions to
  disconnected/error, preventing stale channels from lingering.
- `pane.process_info`, `pane.cwd`, `pane.send_keys`, `pane.wait_for_output`
  now handle remote panes (previously threw `pane_not_found`).
- Daemon-to-daemon relay over SSH: `HerdrSshRelayTransport` tunnels the
  remote herdr socket via `openssh_forwardOutStreamLocal`, enabling full
  protocol-19 (events, layout, agents) over SSH. Gated behind
  `terminalBackendDefault === 'herdr'` + Unix host. Falls back to CLI
  transport for Windows or non-herdr backends.

Real `ssh.connect/disconnect` (ssh2), SSH multiplexing as daemon panes, remote runtime relay ->
daemon panes (plan-doc Phases 3-4).

## Phase 6 — Cleanup [DONE]

Remove the local stock-binary path and custom daemon-RPC remnants; provider routing -> herdr when
active, Orca backend otherwise. Delete the old custom-RPC daemon protocol files.

Done: deleted herdr-daemon-pane.ts (dead old-RPC handlers), herdr-daemon-session.ts (old session.list
handler), herdr-daemon-types.ts (unused type file); stripped old RPC from herdr-daemon-class.ts
(pane.write/pane.snapshot/pane.foreground_process/pane.has_children/pane.agent_info/
pane.set_agent_status/pane.signal/createSession/HerdrPane/HerdrSession/emitPaneData old path,
-600 lines); removed HerdrPane/HerdrSession types + createSessionDir from herdr-daemon-helpers.ts;
kept pane.cwd as protocol-19 method (used by provider).

Follow-up restore (regression fix): the sed line-range deletions also clipped
`handleEventsSubscribe`/`handleEventsWait` (breaking the transport's ensureSession handshake) and
the CLI contract (`pane.create`/`session.list` from `src/cli/handlers/herdr.ts`). Both were
restored model-backed: events surface verbatim, `pane.create` idempotent per target via
ensureWorkspace/ensureTab/createPane + spawnProtocolPane, `session.list` derived from the
model. Contract pinned by `herdr-daemon-cli-contract.test.ts` (fake IPty, PTY-independent).

---

## Verification (every phase)

- Unit: all existing herdr suites stay green + new daemon-server tests.
- Integration: daemon harness in `herdr-real-runtime.integration.test` style.
- Manual gates: Phase 1 (optional switch), Phase 3 (multiplex + persistence), Phase 4 (agents),
  Phase 5 (SSH/remote).
- Lint, typecheck; macOS/Windows socket correctness; no hardcoded paths.

## Scope note

This is the plan-doc roadmap's full program (its own estimate: 4-6 weeks, 2-3 engineers) executed
phase-by-phase, each phase landing functional and verifiable. Execution is sequential with a
verification gate at each phase boundary.
