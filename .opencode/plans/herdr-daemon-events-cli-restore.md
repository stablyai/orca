# Plan: Restore daemon events surface + CLI contract (post-Phase-6 regression fix)

## Context

Phase 6 cleanup (`2a60617fbb`) deleted more than intended:

1. **`handleEventsSubscribe` / `handleEventsWait` accidentally removed** (sed line-range deletion).
   The request switch still calls them (`case 'events.subscribe'`, `case 'events.wait'`).
   `handleEventsSubscribe` also depended on the `HERDR_EVENT_KINDS` constant, which was removed.
   Impact: `HerdrDaemonHostTransport.doEnsure()` calls `events.subscribe` on every session setup,
   so the herdr terminal backend fails at spawn time. This was the primary cause of the daemon
   test failures/hangs observed after the cleanup.
2. **CLI contract deleted against plan instruction.** The plan said "legacy custom-RPC handlers
   untouched (still consumed by the `orca herdr` CLI)" but `pane.create` and `session.list` were
   removed. `src/cli/handlers/herdr.ts` calls both (`herdr session list`, `herdr pane create`).
3. **Type-safety defect in `herdr-transport.ts`**: `this.socket?.readyState` on
   `Socket | Duplex | null` (Duplex has no `readyState`); `isConnected()` loosened to
   `readable && !destroyed`, which reports true while a socket is still connecting.

## Goal

Restore the events surface and CLI contract on top of the protocol-19 model (no old `sessions`
map), keep the Phase 6 cleanup otherwise intact, and verify with targeted tests.

## Non-goals

- Do NOT restore the old `HerdrSession`/`HerdrPane` types or the old two-level session model.
- Do NOT restore `pane.write`, `pane.snapshot`, `pane.foreground_process`, `pane.has_children`,
  `pane.agent_info`, `pane.set_agent_status`, or old `pane.signal` — no consumers remain.

## Steps

### 1. `herdr-daemon-class.ts` — events surface

Restore from parent commit `a3ac790132`, adapted to current class:

- `HERDR_EVENT_KINDS` constant at module scope.
- `handleEventsSubscribe(params, reply: HerdrServerReply)`: validates kinds against
  `HERDR_EVENT_KINDS` (unknown → `unknown_event_type`), calls `reply.subscribe(kinds)`,
  returns `{ type: 'subscription_started' }`.
- `handleEventsWait({ match, timeout_ms })`: Promise long-poll on `eventBus` with
  type/pane_id/workspace_id/tab_id filters, `null` on timeout.
- Re-add `HerdrServerReply` to the `./herdr-transport` type imports.

### 2. `herdr-daemon-class.ts` — CLI contract (model-backed)

Add switch cases `pane.create` and `session.list` with handlers built on
`HerdrDaemonModel` primitives:

- **`handlePaneCreate`**:
  - `model.ensureWorkspace(`${project}/${workspace}`)`; `model.ensureTab(ws.workspace_id, tab)`.
  - If the tab already holds a pane: return its `pane_id` with `isReattach: true` (idempotent).
  - Else: `model.createPane(ws.workspace_id, tab.tab_id, { cwd, label: leaf })`,
    `spawnProtocolPane(pane_id, cwd)`, resize PTY to `cols`/`rows`, write `command` /
    `launchAgent` env exports to the PTY, emit `pane.created`.
  - Return identity-v2 shape: `{ paneId, identity: { version: 2, projectId, workspaceId, tabId,
    leafId, paneId }, isReattach, snapshot: '', snapshotCols, snapshotRows }`.
- **`handleSessionList`**: model-derived `{ sessionList: [...] }` preserving the old wire shape:
  `sessionName` from the model, per-pane `paneId`, `leafId` (pane label), `title` (tab label),
  and one `agent: [{ agent, agent_status, display_agent, cwd, focused }]` entry per pane.

### 3. `herdr-transport.ts` — type safety

- Line ~191: guard `readyState` — `'readyState' in this.socket && this.socket.readyState === 'open'`.
- `isConnected()`: `readyState === 'open'` when the property exists (net.Socket), else
  `!destroyed` (plain Duplex from `connectWithStream`).

### 4. Tests

- `herdr-daemon-events.test.ts`: `events.subscribe` valid → `subscription_started`; unknown kind →
  `unknown_event_type`; `events.wait` timeout → `null`; matching event resolves.
- New `herdr-daemon-cli-contract.test.ts`: `pane.create` → identity v2 shape; duplicate target →
  `isReattach: true`; `session.list` includes the created pane; `pane.close` removes it.

### 5. Verification

1. `oxlint` clean on touched files.
2. Full herdr suite: events-related failures must clear. Any remaining `posix_openpt` failures get
   compared against a baseline run of the same suite on `a3ac790132` before attribution.
3. Update `herdr-in-app-daemon-full-runtime.md`: Phase 6 note amended — `pane.create`/`session.list`
   kept as CLI contract (model-backed), per the original plan instruction.
4. Manual gate (user): herdr backend → open terminal, split, resize, agent → reattach.

## Follow-ups (not in scope)

- Relay transport ensureSession test strengthening (proper duplex pair + full handshake).
- `resolveProject` `{} as Project` fallback in `herdr-project-pty-target.ts` leaves `projectId`
  undefined when nothing matches.
- `emitPaneData`/`pane.exit` notifications kept (no consumers; `scheduleSave` hook).
