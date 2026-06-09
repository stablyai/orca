# Orca Serve Terminal Persistence

## Problem

`orca serve` exposes terminal tabs to paired web clients through the runtime
`session.tabs` API, but the host-side terminal tab registry was process-local.
When the host published an empty session-tabs snapshot for a worktree, the web
client bootstrapped a new terminal, giving the user a fresh shell instead of
the previously running host session.

The browser must remain stateless for terminal identity. Browser storage is
intentionally sanitized because remote handles become stale after a new pairing
or host restart.

## Goals

- Keep the host runtime as the source of truth for paired web terminal tabs.
- Persist `orca serve` terminal tab, leaf, and PTY/session bindings in the
  existing workspace session model.
- Hydrate headless `session.tabs` snapshots from host persistence before a web
  client decides a worktree has no terminals.
- Mirror the SSH persistence model where it applies, while keeping SSH relay
  leases and local serve persistence behind their own provider checks.
- Preserve split-pane identity by routing all activation and attachment through
  parent tab id plus leaf id.

## Non-Goals

- Do not persist remote handles in browser local storage.
- Do not make browser panes supported in headless `orca serve`.
- Do not redesign the terminal daemon or SSH relay.
- Do not treat a persisted PTY id alone as proof that a live process belongs to
  a pane.

## Design

### 1. Persist Runtime-Owned Serve Spawns

The runtime PTY spawn path accepts a main-only `persistHostSessionBinding` flag.
Headless serve sets it when creating session-tab terminals. The PTY handler
then calls `Store.persistPtyBinding` only after validating `worktreeId`,
`tabId`, and stable `leafId`.

This keeps unrelated renderer-local PTY spawns from writing workspace-session
terminal bindings.

### 2. Use Stable Session IDs

Serve-created terminals pass `tabId`, `leafId`, optional `sessionId`, and
`persistHostSessionBinding` into `ptyController.spawn`.

If a pending hydrated terminal has a persisted PTY/session id, activation
passes that id back to the provider. New serve-owned local sessions use a
nonnumeric `serve-${uuid}` id so they cannot collide with older numeric PTY ids
after restart.

### 3. Hydrate Headless Snapshots

Before `list`, `listAll`, subscribe initial emission, activation, close, or
move returns an empty headless state, the runtime hydrates
`mobileSessionTabsByWorktree` from `workspaceSession.tabsByWorktree` and
`terminalLayoutsByTabId`.

Hydration preserves:

- parent terminal tab id
- stable leaf id
- title fields
- active tab and active leaf
- split layout and `ptyIdsByLeafId`
- persisted PTY/session id

Legacy terminal tabs without layout entries are still hydrated using a
deterministic stable leaf id derived from the parent tab id.

### 4. Materialize Pending Tabs On Activation

Hydrated terminal surfaces with no live trusted handle are exposed as
`pending-handle`. Activating one in headless serve materializes the exact
parent tab and leaf on the server, then returns a ready terminal surface.

Explicit leaf activation is exact. If `leafId` is provided and the requested
leaf is missing, the runtime returns `tab_not_found` instead of falling back to
a sibling.

### 5. Require Trusted PTY Identity

For headless-hydrated persisted tabs, a live PTY is safe to expose only when
the runtime record already matches the same worktree, parent tab id, and pane
key. A process-list entry with the same PTY id but no pane identity stays
pending, preventing stale or numeric id collisions from attaching the wrong
terminal.

Renderer-published authoritative session snapshots retain their existing
worktree-only daemon PTY adoption path.

### 6. Close And Move Without A Renderer

Headless close and move have no-renderer mutation paths:

- close hydrates and refreshes first, removes the persisted terminal tab and
  layout, updates active pointers, emits a new snapshot, and kills every live
  trusted leaf under the closed parent tab
- move updates in-memory and persisted tab order without changing PTY bindings

This prevents closed or reordered tabs from reverting on reconnect.

### 7. Renderer Guards

The web client still drops remote terminal identity from browser storage. It
mirrors the host snapshot and activates pending host mirrors through
`session.tabs.activate`.

Bootstrap of a default web terminal is allowed only for a fresh empty snapshot
for the active worktree when no local terminal state already exists. Stale empty
snapshots and fresh empty snapshots racing with staged local terminals do not
create duplicates.

### 8. SSH Parity

Runtime-owned SSH spawns record remote PTY leases with target-local relay PTY
ids while workspace-session PTY bindings keep app-facing ids. Lease writes are
deferred until after binding persistence succeeds for persisted runtime-owned
spawns, so a failed binding save cannot leave durable SSH lease metadata for a
tab/leaf that was not saved.

## Edge Cases Covered

- Browser reload or WebSocket reconnect mirrors host-owned terminal tabs.
- Pending headless terminal activation reuses persisted tab and leaf identity.
- Split panes attach and activate the requested leaf only.
- Removed split leaves fail fast even when siblings remain.
- Legacy tabs without layouts hydrate instead of appearing empty.
- Stale empty snapshots do not bootstrap duplicate terminals.
- Fresh empty snapshots do not bootstrap when local terminal state already
  exists.
- Numeric PTY id collisions remain pending until a safe reattach/spawn occurs.
- SSH reattach failure after binding persistence failure leaves no stale lease.

## Verification Plan

- Unit-test runtime hydration, activation, close, move, split-leaf exactness,
  stale PTY id handling, and legacy no-layout tabs.
- Unit-test PTY persistence gates, local session-id reattach behavior, SSH
  lease parity, and persistence failure cleanup.
- Unit-test renderer snapshot bootstrap guards and remote runtime PTY transport
  pending-mirror behavior.
- Run adjacent session-tab RPC and web-runtime session tests.
- Run typecheck, lint, and `git diff --check`.
- Launch the Electron dev app from this worktree with an isolated profile and
  verify CDP attachment, app identity, store availability, visible boot, and
  zero console errors.
