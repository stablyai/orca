# Direct local empty-tab retirement

A renderer can close a never-bound local terminal tab while the host still retains its row.
Once the host has established a positive terminal topology revision, an ordinary renderer save
cannot authorize removal of host-owned membership: the host rebases the omitted row back into
persistence. This is a concrete tab-resurrection path relevant to #17344. It does not establish
that this metadata path caused the reported gigabyte growth in #19831 or #19768.

## Result

CI follow-up found that store-only close tests have no renderer `window`. The optional request now exits before touching the bridge in that environment. Both affected suites and the retirement suites pass (42 tests), including a direct windowless-close regression. The before/after restart proof still has the expected two baseline failures and ten fixed passes.

The portable proof enters the actual renderer `closeTab`, preload session bridge, registered
main IPC handler, Store, runtime and disk reload. It uses paired fixture IPC ports, temporary
state and no real window, PTY, shell, SSH connection or external host.

| Actual-source phase                          | Pass | Fail | Exit |
| -------------------------------------------- | ---: | ---: | ---: |
| Before, reversing only `fix.patch` in memory |    8 |    2 |    1 |
| Fixed source                                 |   10 |    0 |    0 |

Only the worktree/folder close-and-restart cases fail before. Controls preserve a queued
request's newer pin, creation identity, same-clock bound replacement, unpersisted runtime PTY,
spawn reservation, renderer-owned epoch-zero sibling, unavailable-host behavior, and ordinary
reopen with a new UUID. `results.json` records source hashes, case names, process exits and
non-timeout status. Source changes that no longer reverse the patch stop the runner.

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/local-empty-tab-retirement/reproduce.mjs
```

## Authority and implementation

The new desktop-only optional session method carries the original worktree, tab UUID,
creation time and generation zero. Both sides restrict it to local, initial empty terminal
rows. Main independently rechecks current row identity, unique location, pin, structured
session ownership, layout, PTY bindings, sleeping state and retained history. Repo and folder
execution-host resolution must both establish local ownership.

The runtime query reads existing graph, leaf, PTY and mobile-snapshot ownership. Existing
renderer-spawn reservations, runtime-create claims and stable-pane adoptions also block
retirement, including the same UUID owned elsewhere. Disconnected or unverifiable PTYs remain
owners; no process liveness is inferred. The original rootless graph and its derived empty
mobile placeholder remain eligible.

Main reuses `closeTerminalTabInWorkspaceSession`, advances an **already positive** topology
revision, writes the session and calls synchronous `flushOrThrow`. There is no await between
admission and persistence. A provider completion queued during the query or flush runs after
this transaction; its later admitted successor stays owned and rejects the older request.
No close receipt, tombstone, process probe, kill request or new owner registry is added.

An optional preload method preserves compatibility with an older retained desktop bridge;
a missing main handler rejects. This is not a paired RPC, SSH protocol or persisted schema
change. Renderer UI `onClosed` remains local UI completion, not durable host acknowledgement.

## Identity and scope limits

- Creation time is not a universal incarnation token. Every current production explicit-ID
  `createTab` caller supplies an existing PTY and immediately creates a leaf:
  `terminal-presentation-ipc-bridge`, `worktree-agent-live-surface-adoption`, and
  `adopt-agent-background-session-tab`. That stronger ownership blocks a same-clock replacement.
  Ordinary reopen mints a new UUID. No supported same-ID, rootless replacement producer was
  found; arbitrary naked reuse through the internal store API is not claimed distinguishable.
- Epoch zero remains renderer-owned. Arming it during a close would discard an unrelated
  never-saved sibling. The existing positive-epoch rejection of newly unsaved membership is
  unchanged; this action does not widen creation authority.
- A previously published mobile snapshot may remain until the normal empty renderer graph
  arrives. This metadata action does not synthesize that graph or declare process death.
- Future host-admitted creation or raw pane spawn remains valid. The existing spawn API does
  not carry the old row creation identity, so this change does not distinguish a delayed old
  external launch from a fresh authorized one or install a permanent no-spawn tombstone.
- A durable flush error propagates and leaves the prior disk file intact; staged memory
  changes are not rolled back. Missing runtime ownership information refuses success.
- Bound tabs, restored history, mounted leaves, structured chats, SSH and paired-runtime
  workspaces remain outside this narrow action. Explicit acknowledged whole-tab close has a
  separate audit in `acknowledged-tab-retirement`.

## Additional validation

The focused source suite passes **29 tests across four files**; existing creation-hint, reopen
and active-workspace close suites pass **43 tests across three files**. Permanent source
regressions cover pending adoption/creation/spawn ownership, unrelated UUIDs,
registered PTYs before persistence, real mounted graph admission, reservation failure release,
queued provider completion, latest identity/pin, local folder/worktree scope, stale saves,
failed flush and older preload behavior.

```sh
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/ipc/session-empty-terminal-tab-retirement.test.ts src/main/ipc/session-empty-terminal-tab-runtime-owner.test.ts src/renderer/src/store/terminals/terminal-tab-close-empty.test.ts src/main/ipc/register-core-handlers/register-core-handlers.test.ts
```

The reviewed integration also passed 47 cases against a bounded overlay of main
`291b4ddd6f1c1af480169885e0fda7f9c78ff053`; the seven changed existing source/test files matched
that base and the exact patch passed an alternate-index apply check. The promoted fixture is
independent of the separate acknowledged-close fix.
