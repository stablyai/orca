# SSH Handler Re-registration Port Forwards

## Problem

Issue #2932 reported that macOS window reactivation can re-run
`attachMainWindowServices`, which calls `registerSshHandlers` again
([src/main/window/attach-main-window-services.ts:83](src/main/window/attach-main-window-services.ts:83)).

Before this change, `registerSshHandlers` removed and re-added IPC handlers but
also replaced the module-level `connectionManager` and `portForwardManager`
([src/main/ipc/ssh.ts:438](src/main/ipc/ssh.ts:438),
[src/main/ipc/ssh.ts:439](src/main/ipc/ssh.ts:439)).
`activeSessions` remains module-global
([src/main/ipc/ssh.ts:63](src/main/ipc/ssh.ts:63)),
so live relay sessions kept references to the old port-forward manager while
new IPC handlers read a fresh empty one.

The visible failure is:

1. Connect an SSH target.
2. Add a local port forward.
3. Close all windows on macOS while the app process remains alive.
4. Reactivate Orca, causing SSH handlers to register again.
5. `ssh:listPortForwards` returns an empty list, `ssh:removePortForward` cannot
   remove the old forward id, `ssh:addPortForward`/`ssh:updatePortForward` can
   fail because the fresh connection manager has no live connection, and
   `ssh:disconnect` does not close the old SSH connection or local listener.
   Re-adding the same local port fails because the old server remains bound.

## Root Cause

SSH handler registration mixes two lifetimes:

- Process-lifetime session state: active SSH connections, relay sessions, port
  listeners, relay lost backoff, reset/connect in-flight maps.
- Window-lifetime callback state: `getMainWindow` and renderer IPC handlers.

The previous re-registration path preserved `activeSessions` but replaced the
managers that sessions and IPC handlers must share. Port-forward IPC operations
use `portForwardManager` ([src/main/ipc/ssh.ts:992](src/main/ipc/ssh.ts:992),
[src/main/ipc/ssh.ts:1047](src/main/ipc/ssh.ts:1047),
[src/main/ipc/ssh.ts:1056](src/main/ipc/ssh.ts:1056)),
and disconnect/terminate cleanup also uses that variable
([src/main/ipc/ssh.ts:750](src/main/ipc/ssh.ts:750),
[src/main/ipc/ssh.ts:814](src/main/ipc/ssh.ts:814)).
After replacement, those operations no longer targeted the manager that owns the
live local servers. Replacing `connectionManager` also strands the live
`SshConnection` objects: existing relay sessions still hold their current
connection, but new IPC handlers and `getSshConnectionManager()` see an empty
manager.

## Non-goals

- Do not change relay protocol, remote deployment, or SSH transport behavior.
- Do not redesign port-forward persistence or enrichment.
- Do not change renderer UI.
- Do not introduce a second SSH service layer.
- Do not force-dispose live SSH sessions merely because a window was recreated.

## Design

1. Preserve process-lifetime managers across handler re-registration.
   Instantiate `SshConnectionManager` and `SshPortForwardManager` only when
   absent; later `registerSshHandlers` calls reuse the existing instances.

2. Refresh every live callback owner on re-registration. This is required; a
   plain `connectionManager ??= new SshConnectionManager(callbacks)` is not
   enough.
   - `SshConnectionManager` must update callbacks used by both future and
     existing `SshConnection` objects, either via explicit `setCallbacks` methods
     on manager/connection or via a stable callback proxy whose implementation
     is mutable.
   - Existing `SshRelaySession` objects must refresh `getMainWindow`, store,
     runtime, and detected-port callback references. Event handlers must call
     the current callback at event time; do not capture the old `getMainWindow`
     in long-lived provider callbacks.
   - The credential-request tracking set must not be per-registration if live
     connections can switch callbacks during an in-flight `ssh:connect`.

3. Re-register IPC handlers and dependent global listeners on every call.
   `ipcMain` handlers, advertised URL refresh, credential IPC, browse handler,
   and power-monitor listeners are window-registration concerns and should still
   point at the latest window.

4. Preserve existing explicit teardown behavior.
   `ssh:disconnect`, `ssh:terminateSessions`, `ssh:removeTarget`, reset, and
   double-connect cleanup must still remove forwards through the shared manager
   before detaching or disposing sessions.

5. Add regression tests in `src/main/ipc/ssh.test.ts`.
   Connect a target, add a mocked port forward, call `registerSshHandlers`
   again, then assert:
   - `ssh:listPortForwards` still returns the original forward.
   - `ssh:removePortForward` can remove the original id.
   - `ssh:addPortForward`/`ssh:updatePortForward` still use the original live
     connection.
   - A second re-registration followed by `ssh:disconnect` still calls
     `removeAllForwards` and `disconnect` on the original shared managers.
   - State, credential, PTY, and detected-port callbacks from an existing live
     session publish to the newest window after re-registration.

## Data Flow

- First registration:
  - `registerSshHandlers(store, getWindowA)` creates store wrapper, connection
    manager, port-forward manager, handlers, listeners, and current callback
    environment.
  - `ssh:connect` creates a relay session with the shared port-forward manager.
  - `ssh:addPortForward` stores a local server in that same manager.

- Window reactivation:
  - `registerSshHandlers(store, getWindowB)` removes/re-adds IPC handlers.
  - Existing managers are reused.
  - Existing connection and relay-session callback owners are refreshed to the
    latest store/runtime/window environment.
  - New handlers close over `getWindowB` and call the same managers.

- Cleanup:
  - `ssh:removePortForward` and `ssh:disconnect` operate on the same manager
    that owns the live forward, then broadcast through the latest window.

## Edge Cases

- Re-registration while a target is connected and has active port forwards.
- Re-registration while `ssh:connect`, `restorePortForwards`, reset, reconnect,
  or disconnect is in flight. The operation must not split credential tracking
  or create a session that holds stale callbacks.
- Re-registration while no targets are connected.
- Re-registration after the store object changes. Either update existing relay
  sessions to use the new store/runtime or document and test the stronger
  invariant that production re-registration always passes the same process
  store/runtime.
- Re-registration after the window changes. All broadcasts, credential prompts,
  PTY events, detected-port events, advertised URL refreshes, relay-loss state
  changes, and terminal relay errors must use the newest `getMainWindow`.
- Disconnect after re-registration must release old local ports.
- `ssh:connect` after window reactivation must be idempotent when the existing
  session is already ready and healthy: return the connected state without
  tearing down forwards. Explicit reset/reconnect or non-ready replacement paths
  must still await old port teardown before restoring forwards.
- `getSshConnectionManager()` consumers must continue to see live connections
  after re-registration.
- Test isolation must not depend on module-singleton state leaking between
  tests. Add explicit reset/teardown support if preserving managers makes
  `beforeEach(registerSshHandlers)` insufficient.
- SSH and relay paths must keep working for remote targets; the fix must not
  assume local filesystem or local-only execution.
- Windows/Linux remain unaffected: re-registration can still happen during
  development or future window lifecycles, and the fix must avoid path or
  platform assumptions.

## Test Plan

- Unit: `pnpm vitest run --config config/vitest.config.ts src/main/ipc/ssh.test.ts`
  - Add regression coverage for list/remove/disconnect after handler
    re-registration.
  - Add coverage that add/update after re-registration uses the still-live
    connection manager connection, not a fresh empty manager.
  - Add coverage that existing connection/session callbacks publish to a second
    mock window after re-registration.
  - Add an in-flight connect or credential-request test if callback refresh uses
    mutable callback objects.
  - Existing connect, disconnect, reset, relay-loss, and terminate tests cover
    adjacent lifecycle behavior.
- Typecheck: `pnpm typecheck`.
- Lint: `pnpm lint`.
- Electron/SSH validation: use an existing SSH target such as `openclaw 2` if
  available in the running app, add a disposable local port forward, trigger
  window/service re-registration by closing and reopening the main window on
  macOS, then verify the forward remains listed and removable. IPC/unit tests
  are supporting evidence only; if the golden path cannot be exercised safely,
  halt before PR and report the missing evidence.

## UI Quality Bar

Not UI-visible. No layout, copy, or visual styling changes are expected. The
only user-visible expectation is that existing SSH port-forward rows remain
present and actionable after window reactivation.

## Review Screenshots

1. SSH target connected with a port forward listed before re-registration.
2. Same SSH target after window reactivation, showing the same port forward
   still listed.
3. Same SSH target after removing the port forward, showing it gone without an
   error.

## Rollout

1. Add the focused regression test to prove the current lifecycle bug.
2. Change SSH handler registration to reuse process-lifetime managers.
3. Run the focused test, then typecheck and lint.
4. Validate in Electron against an SSH target if feasible; otherwise halt
   before PR if the golden-path SSH UI cannot be exercised.

## Lightweight Eng Review

- Scope: reduced to SSH IPC lifecycle only. No relay, renderer, or persistence
  redesign is needed because the broken boundary is manager replacement during
  handler re-registration.
- Architecture/data flow: process-lifetime managers stay module-level and are
  reused; window-lifetime IPC handlers/listeners are refreshed; existing
  connection and relay-session callback owners must also be refreshed or proxied
  so live events target the current BrowserWindow.
- Failure modes covered:
  - Active forwards becoming invisible after re-registration.
  - `ssh:removePortForward` missing the old forward id.
  - `ssh:addPortForward`/`ssh:updatePortForward` failing against a fresh empty
    connection manager.
  - `ssh:disconnect` failing to close old SSH connections and local listeners
    after re-registration.
  - Store/window/runtime callback refresh after re-registration.
  - Re-registration during in-flight connect/reset/reconnect.
  - No-session re-registration continuing to work.
- Test coverage required:
  - Unit in `src/main/ipc/ssh.test.ts` for connect/add/list/remove across
    `registerSshHandlers` calls.
  - Unit in `src/main/ipc/ssh.test.ts` for disconnect cleanup after
    re-registration.
  - Unit in `src/main/ipc/ssh.test.ts` for existing live callbacks reaching the
    newest window after re-registration.
  - Unit in `src/main/ipc/ssh.test.ts` for no-session re-registration and test
    teardown/reset of module singletons.
  - Existing lifecycle tests for reset, terminate, relay loss, and sleep remain
    adjacent coverage.
- Performance/blast radius: no material startup or IPC cost. Reusing managers
  avoids leaked runtime state and does not add polling, watchers, or
  cross-process calls. Callback refresh is O(number of live SSH connections and
  sessions) per registration, which should be tiny.
- UI quality bar: not UI-visible; preserve existing SSH port-forward UI state
  rather than changing layout or copy.
- Required review screenshots:
  1. Connected SSH target with active port forward before re-registration.
  2. Connected SSH target with same port forward after re-registration.
  3. Connected SSH target after removing that forward.
- Feasibility: one-time manager creation is feasible only with callback refresh
  for existing `SshConnection` and `SshRelaySession` instances. If that refresh
  proves larger than expected, prefer a stable callback proxy over recreating
  managers; do not dispose live sessions just to make callback ownership easier.
- Residual risks: Electron validation may be constrained by availability of an
  existing SSH target and by avoiding live-user port collisions. If the golden
  path cannot be exercised safely, stop before opening a PR and report the
  missing manual evidence.
