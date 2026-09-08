# TASK-030: Implement `onboarding.openGhAuthTerminal` — unblocked, shipped

**From Solution:** SOL-010
**Priority:** P2 → shipped
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go` (`registerOnboardingOpenGhAuthTerminalChannel`), test in `channels_onboarding_test.go`
**Depends on:** SOL-008's `terminal.create` (TASK-019–TASK-026) — **landed**, confirmed by re-reading `channels_terminal.go` before starting this task
**Status:** `[x] DONE`

---

## Deviation from the original task file (why this shipped instead of staying blocked)

The original version of this task concluded `onboarding.openGhAuthTerminal` was blocked
transitively on TASK-022 (`environmentId` → `dev_server_id` resolution for ephemeral VMs),
via an overly conservative "TASK-019-025 must all be done" dependency check. Re-verified
against the real desktop precedent
(`desktop/src/main/ipc/onboarding-ipc.ts:214-229`, `openGhAuthTerminalForDevServer`): this
RPC has always been keyed by a concrete `devServerId` the caller already has, never a bare
`environmentId` — it has nothing to do with TASK-022's "bare runtime environment with no
compute bound yet" scenario. The real, narrower dependency is only on `terminal.create`'s
connection-bound spawn path, which landed with TASK-019–021. So this task now ships a real
implementation instead of a second blocker writeup. TASK-022 remains genuinely blocked on
its own unrelated gap (see its own file) — this deviation does not change that.

## What shipped

`registerOnboardingOpenGhAuthTerminalChannel` (`channels_onboarding.go`), registered via
`Registry.RegisterStreamChannel` (not `Register`) since — exactly like `terminal.create` —
its invoke must both ack with `{ ptyId, devServerId }` (the frontend's real contract, see
`frontend/src/preload/api-types.ts`'s `openGhAuthTerminal` type and
`runtime-onboarding-client.ts:108-117`'s `openRuntimeOnboardingGhAuthTerminal`) AND open a
live push subscription that keeps delivering `terminal.output`/`terminal.exited` for the
rest of the pty's life.

Flow, mirroring `registerTerminalCreateChannel`/`registerTerminalSendChannel`
(`channels_terminal.go:227-349`) almost exactly:

1. Decode `{ devServerId }`.
2. `client.ResolveConnection(ctx, &ResolveConnectionRequest{DevServerId: in.DevServerID})` —
   the `dev_server_id` alternate-key path `ResolveConnectionRequest` already supports
   (`infrafleet.proto:252-267`), the same one `channels_browser.go`'s worktree-keyed lookups
   and ai-provider-service's `TestConnection` already use for the request's other two keys.
   `connected == false` returns `ONBOARDING_DEV_SERVER_NOT_CONNECTED: <id> has no live agent
   session` — a normal "come back later" onboarding state, matching
   `onboardingGetPreflightStatus`'s identical convention, not a crash.
3. `client.SpawnTerminalSession` with the **resolved connectionId** (not the raw
   devServerId), then `client.AttachPty` + the same `terminalStreamEntry`/
   `terminalStreamRegistry`/`drainAttachPtyOutput` plumbing `terminal.create` uses, so
   `terminal.output`/`terminal.exited` push events reach the frontend exactly like any other
   terminal pane.
4. Immediately after registering the stream entry, types `"gh auth login\n"` into the pty
   as terminal input (same `PtyClientFrame_Input` frame `terminal.send` sends) — necessary
   because the agent's `pty.create` RPC only accepts `{cwd, cols, rows, env,
   shellOverride}`, no direct command+args (`agent/src/relay/agent-rpc-dispatch-pty.ts:26-28`),
   so running a specific command means spawning a plain shell and typing into it like a real
   user would.
5. Returns `{ ptyId, devServerId }` (`onboardingOpenGhAuthTerminalResultView`) — the frontend
   attaches a terminal pane to `ptyId` via the same `terminal.subscribe`/`terminal.output`
   machinery any other `terminal.create`'d pty uses.

No proto changes were needed anywhere in this task.

## Test coverage added

`channels_onboarding_test.go`:

- `TestOnboardingOpenGhAuthTerminal_ResolvesConnectionSpawnsPtyAndTypesCommand` — success
  path: asserts `ResolveConnection` is called with the devServerId, `SpawnTerminalSession`
  is called with the *resolved* connectionId (not the raw devServerId), the ack shape is
  `{ptyId, devServerId}`, the AttachPty stream's first frame is the attach frame, and its
  second frame types `"gh auth login\n"`.
- `TestOnboardingOpenGhAuthTerminal_DevServerNotConnected_ReturnsExpectedError` — a resolved
  but disconnected dev server returns `ONBOARDING_DEV_SERVER_NOT_CONNECTED` and never calls
  `SpawnTerminalSession`.
- `TestOnboardingOpenGhAuthTerminal_RequiresDevServerID` — fail-closed argument validation,
  matching every other devServerId-keyed onboarding channel's own guard.

## Verify

```
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/...
```

All three are clean as of this task (`go test` run included the full `wscompat` package,
not just the new tests — no regressions).
