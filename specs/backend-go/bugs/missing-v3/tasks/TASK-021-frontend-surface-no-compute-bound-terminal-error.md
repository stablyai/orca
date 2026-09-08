# TASK-021: Surface `INFRA_TERMINAL_NO_COMPUTE_BOUND` as an actionable terminal-pane message instead of a generic transport failure

**From Solution:** SOL-008
**Priority:** P1 — depends on the backend rename landing first so the code string this task matches on actually exists on the wire
**Service:** `frontend` (`terminal-pane`)
**File:** `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts`, `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.test.ts`
**Depends on:** TASK-019, TASK-020 (both must land first — this task matches on the `INFRA_TERMINAL_NO_COMPUTE_BOUND` code string those tasks introduce; matching on the old `INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED` string would work today but is exactly the debt SOL-008 is removing)
**Status:** `[x]` DONE — implemented as specified (TASK-019/020 already landed so the code string exists). Verified via `vitest run remote-runtime-pty-transport.test.ts` (63/63 pass, including the new no-compute-bound case) and `npx tsc --noEmit -p .`; the only pre-existing tsc error in this file (`Property 'terminalSessions' does not exist on type 'PreloadApi'`, line ~1064) predates this change and is unrelated. Also refreshed the stale `INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED` reference in the nearby `terminal.create` params comment to the new code name for consistency.

---

## Context

`remote-runtime-pty-transport.ts`'s own comment (lines 898-906) already
documents finding `INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED` live in
production as an opaque RPC failure. Once TASK-019/020 rename it to
`INFRA_TERMINAL_NO_COMPUTE_BOUND`, `connect()`'s catch clause should
recognize it and call `onError` with a distinct, actionable message
("this environment has no compute attached") instead of whatever generic
transport-failure text `runtimeTerminalErrorMessage(error)` would
otherwise produce — this is the terminal-pane-level equivalent of
`channels_dev_server_access_control.go`'s pattern of surfacing a specific,
actionable denial rather than a bare error (cited in SOL-008).

**Scope note:** this task only changes what error *message* the pane
receives via the existing `onError?: (message: string, errors?: string[])
=> void` callback (`pty-transport-types.ts:67`) — there is no existing
"bind a dev server" UI entry point in the codebase for this message to
deep-link into (grepped for `bind.*dev.?server`/`attach.*compute`/
`no compute` across `frontend/src/renderer/src` — no hits). Designing an
actual call-to-action button/flow is a separate, larger frontend UX task
not scoped here; this task ships the smaller, real, immediately useful
half (a human-readable explanation instead of an opaque RPC error string).

## Changes to make

### 1. Add a message-matching helper

`remote-runtime-pty-transport.ts:74-76` already has the established
pattern for recognizing a specific backend error by substring match on
`runtimeTerminalErrorMessage(error)` (see also
`runtime-file-client.ts:354-355`'s `error.message === 'file_too_large'`
for the same class of match against a wire error whose `.message` carries
the backend's `apperrors.AppError` string, formatted as `"<CODE>: <text>"`
by `AppError.Error()`/`ToStatus()`):

```ts
// remote-runtime-pty-transport.ts:74-76, existing sibling pattern
function isNoLiveAttachPtyStreamMessage(message: string): boolean {
  return message.includes('no live AttachPty stream')
}
```

Add a new helper next to it:

```ts
// SOL-008 (specs/backend-go/bugs/missing-v3/): infra-fleet-service's
// SpawnTerminalSession returns this code when a runtime:<environmentId>
// target has no dev-server/SSH connection bound yet — a fixable
// precondition, not a bug. AppError.ToStatus() formats the gRPC status
// message as "<CODE>: <text>", so match on the code prefix rather than the
// full message (the message text itself is not a stable contract).
const NO_COMPUTE_BOUND_ERROR_CODE = 'INFRA_TERMINAL_NO_COMPUTE_BOUND'

function isNoComputeBoundMessage(message: string): boolean {
  return message.includes(NO_COMPUTE_BOUND_ERROR_CODE)
}
```

### 2. Catch it in `connect()`

Current code (`remote-runtime-pty-transport.ts:963-966`, the tail of
`connect()`'s try block):

```ts
      } catch (error) {
        storedCallbacks.onError?.(runtimeTerminalErrorMessage(error))
        return undefined
      }
```

Replace with:

```ts
      } catch (error) {
        const message = runtimeTerminalErrorMessage(error)
        if (isNoComputeBoundMessage(message)) {
          storedCallbacks.onError?.(
            'This environment has no compute attached — attach a dev server or SSH connection to this environment before opening a terminal.'
          )
        } else {
          storedCallbacks.onError?.(message)
        }
        return undefined
      }
```

## Verify

```bash
cd frontend
pnpm test -- --run remote-runtime-pty-transport.test.ts
```

Add a new test case near the existing `onError`-asserting tests (e.g.
alongside `'retires the mirror when the host no longer publishes the
surface after a transport close'`, `remote-runtime-pty-transport.test.ts:370`):
mock `terminal.create` to reject with an error whose `.message` contains
`INFRA_TERMINAL_NO_COMPUTE_BOUND` (matching how other tests in this file
mock the runtime RPC client's rejection shape — check an existing
`onError`-asserting test for the exact mock plumbing before writing this
one), call `transport.connect({ url: '', callbacks: { onError } })`, and
assert `onError` was called with the "no compute attached" message, not
the raw RPC error string.
