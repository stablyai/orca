# BUG-008: `terminal.create` — registered and functional for connection-bound targets, but permanently fails for connectionless "runtime" environments

**Service:** `infra-fleet-service` (owns `SpawnTerminalSession`), wired through `api-gateway`'s `wscompat` registry
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go:227-274` (`registerTerminalCreateChannel`); `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go:55-66` (`SpawnTerminalSession.Execute`)
**Severity:** Medium (downgraded from the pre-screening candidate's "High" — see below; still a real, user-visible dead end for one whole class of target)
**Status:** ⚠️ Partial — the channel exists and works for the dev-server/SSH connection-bound case; it is a **hard, permanent failure** (not a missing-registration gap) for a connectionless "runtime" environment target
**Symptom:** A terminal pane backed by a worktree whose execution host is a bare `runtime:<environmentId>` (no SSH `connectionId`, no dev-server binding) can never spawn a PTY through backend-go — `terminal.create` immediately fails with `INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED` (or `INFRA_TERMINAL_HOST_LOCAL_DISABLED` in server-deployment mode).

---

## Correcting the pre-screening candidate

`missing-v3-candidates.md` claimed: "every other `terminal.*` method... IS registered, but the one method that actually spawns a new PTY session is not [registered] — meaning a remote/backend-go-backed terminal pane can never come into existence." **This premise is false.** `terminal.create` IS registered:

```
$ grep -n '"terminal.create"' backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go
228:	r.RegisterStreamChannel("terminal.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
```

The pre-screening grep (`\.Register\("...`) missed it because `terminal.create` uses `Registry.RegisterStreamChannel`, a distinct method from `Registry.Register` — the same class of false-negative documented in `BUG-007` for `files.*`'s `simpleFileOp` helper. `terminal.create` is exercised end-to-end by a real, passing test suite (`channels_terminal_test.go:201-337`, including a full ack→`terminal.output`→`terminal.exited` push-frame roundtrip), and by `registerTerminalChannels` (`channels_terminal.go:124-149`), which is called from `RegisterRealChannels`.

So the namespace is **not** "1 of 14 unregistered." All 14 `terminal.*` methods the frontend calls are registered. The real, narrower issue is below.

## What's actually missing

`terminal.create`'s backing usecase, `SpawnTerminalSession.Execute`, only knows how to spawn a PTY on a **connection-bound** dev server:

```go
// backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go:61-66
if in.ConnectionID == "" {
    if uc.serverDeployment {
        return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_DISABLED", "host-local terminal sessions are disabled in server-deployment mode", nil)
    }
    return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED", "host-local terminal sessions are not implemented — every PTY this service can spawn today must go through a connectionId-bound dev server agent", nil)
}
```

The doc comment above it (`spawn_terminal_session.go:28-36`) is explicit that this is a **known, permanent architectural gap, not a TODO**: "there is no local-pty adapter in backend-go (PTYs only exist inside the agent's detached pty-daemon process)... a host-local request always fails today, with a distinct error explaining why, rather than silently no-opping. Tracked as a known gap, not implemented by this pass."

### Confirmed reachable from a genuine `target.kind === 'environment'` call, not just a theoretical edge case

The frontend's own transport code documents hitting this live:

```ts
// frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts:900-906
// Why: backend-go's terminal.create (channels_terminal.go) only
// reads connectionId, never worktree — SpawnTerminalSession takes
// an empty ConnectionID as "spawn a host-local PTY", which the
// web deployment cannot do (INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED,
// found live 2026-08-30). Every dev-server-bound terminal on web
// rides this transport, so connectionId must travel with it.
```

Tracing where `connectionId` comes from for this transport (`frontend/src/renderer/src/components/terminal-pane/pty-connection.ts:3046`):

```ts
const connectionId = tab?.connectionId ?? getConnectionId(deps.worktreeId) ?? null
```

`getConnectionId` (`frontend/src/renderer/src/lib/connection-context.ts:15-17`) resolves **only an SSH connectionId** — "Returns null for local repos, the target ID string for remote repos". Separately, `runtimeEnvironmentId` (which decides whether this remote/backend-go transport is used at all — `pty-connection.ts:3097-3113`) is derived from `getRuntimeEnvironmentIdForWorktree`, which recognizes a worktree/repo host of the form `runtime:<environmentId>` (`frontend/src/renderer/src/lib/worktree-runtime-owner.ts:102-107,162-193`) **independently of whether any SSH `connectionId` or dev-server binding exists**. So:

- A worktree hosted on a dev server or an SSH target → `connectionId` is set → `terminal.create` reaches `SpawnTerminalSession` with a real `ConnectionID` → works (this is the documented, tested, working path).
- A worktree whose execution host is a bare `runtime:<environmentId>` (no SSH target, no dev-server binding registered for it) → `connectionId` is `null` → `terminal.create`'s wire args carry no `connectionId` (`remote-runtime-pty-transport.ts:907`: `...(connectionId ? { connectionId } : {})`) → `SpawnTerminalSession.Execute` takes the `in.ConnectionID == ""` branch → **hard failure**, every time, for every terminal pane on that environment.

This is not a hypothetical: the frontend comment says it was "found live 2026-08-30," i.e., this failure has already been observed in production for exactly this class of target.

## Why this is a real, if narrower, capability gap

`SpawnTerminalSession` has no fallback for "this is a `runtime`-kind environment with no dev-server/SSH connection concept, but I still need to run a shell somewhere for it." Two live-and-documented adjacent mechanisms exist that a fix could plausibly build on, but neither is wired into `SpawnTerminalSession` today:

- `RelayByDevServer` (`infra-fleet-service`'s bypass for reaching a dev server's agent before an `infra.connections` row exists — see `git-gateway-service`'s `relay_executor.go:43-62`) is used by `git-gateway-service`'s own relay dispatch, but `SpawnTerminalSession` does not thread a dev-server-id-as-fallback the same way (it does fall back to treating `ConnectionID` as a `devServerId` directly when non-empty and unresolved — `spawn_terminal_session.go:72-89` — but only when the caller supplies *some* id; an empty `ConnectionID` never reaches that fallback at all).
- The `ephemeralVm.*` namespace (separately flagged as a 9-method full gap in the same pre-screening pass — see `missing-v3-candidates.md`) looks like the natural provisioning step that should hand `SpawnTerminalSession` a concrete dev-server/connection id for a `runtime:<environmentId>` target before a terminal is ever requested; if `ephemeralVm.attachWorkspace`/`resumeWorkspace` were implemented and always ran before `terminal.create` for this target class, this gap might already be moot in practice. That namespace is out of this report's scope (assigned elsewhere) — flagging the dependency for whoever picks up either.

## Owning service verdict

`infra-fleet-service` already owns `terminal.create`'s entire implementation end-to-end and is unambiguously the right owner for closing this gap too — this is not a "no service owns it" case like several `missing-v1` findings. What's missing is either (a) a real host-local PTY adapter in backend-go itself (the comment's first-choice framing), or (b) wiring `SpawnTerminalSession` to resolve a `runtime:<environmentId>` target to a concrete dev server via whatever mechanism ultimately backs `ephemeralVm.*`, so `ConnectionID` is never actually empty by the time it gets here.

## Severity note

Downgraded from the candidate's "HIGH... a remote/backend-go-backed terminal pane can never come into existence" (which would mean the feature is 100% broken for every remote/environment target) to **Medium**: the connection-bound path (dev server or SSH target) — which is the common case per the frontend's own comment ("every dev-server-bound terminal on web rides this transport") — works, is tested, and is live. The gap is scoped to the specific, narrower "environment has no dev-server/SSH binding at all" case.

---

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go:227-274` — `registerTerminalCreateChannel`, real `SpawnTerminalSession`/`AttachPty` wiring, confirmed registered via `RegisterStreamChannel`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go:124-149` — `registerTerminalChannels`, confirms all 14 `terminal.*` methods the frontend calls are registered
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal_test.go:201-337` — passing end-to-end test coverage for the connection-bound `terminal.create` path
- `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go:28-36,55-66` — the documented, deliberate host-local-unimplemented gap
- `backend-go/services/infra-fleet-service/internal/usecase/terminal_session_lookup.go:36-42` — same limitation echoed in every other terminal control-plane usecase (`resize`/`kill`/`wait`/`focus`/`agentStatus`/`inspectProcess`) via `resolveTerminalSession`'s `INFRA_TERMINAL_HOST_LOCAL_UNSUPPORTED` guard — confirms this isn't only a creation-time gap, it's structural
- `backend-go/services/infra-fleet-service/cmd/server/main.go:182` — `cfg.ServerDeployment` threaded into `NewSpawnTerminalSession`, gating which of the two error variants fires
- `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts:898-924` — the `terminal.create` call site, with the frontend's own "found live 2026-08-30" comment
- `frontend/src/renderer/src/components/terminal-pane/pty-connection.ts:3046,3097-3130` — derivation of `connectionId` (SSH-only) vs. `runtimeEnvironmentId` (recognizes bare `runtime:<environmentId>` hosts independently)
- `frontend/src/renderer/src/lib/connection-context.ts:10-17` — `getConnectionId`'s doc comment: null for local, an id for SSH-remote, nothing for a bare runtime host
- `frontend/src/renderer/src/lib/worktree-runtime-owner.ts:102-107,162-193` — `getRuntimeEnvironmentIdForWorktree`/`getExplicitRuntimeEnvironmentIdFromHost`, recognize `runtime:`-kind hosts independently of any connection
- `specs/backend-go/bugs/missing-v1/BUG-029-terminal-channels-not-implemented.md` — predecessor (Aug snapshot: "10/10 missing... `infra-fleet-service` has only generic `Relay`"), now stale — `terminal.*` has since grown a full, real, tested implementation; this report's gap is the one genuine remainder
- `/tmp/claude-1000/-opt-repos-orca/8cdf0282-e9bf-470b-97f8-c03bed6dcd57/scratchpad/missing-v3-candidates.md` — the pre-screening candidate this report corrects (claimed `terminal.create` unregistered; it is registered, but has this narrower functional gap instead)
