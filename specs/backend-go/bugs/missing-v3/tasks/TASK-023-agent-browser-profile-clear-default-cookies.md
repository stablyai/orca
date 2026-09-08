# TASK-023: Implement `browser.profileClearDefaultCookies` on the Dev Server Agent

**From Solution:** SOL-009
**Priority:** P1 — trivial, no dependencies, unblocks one of the three already-registered-but-inert `browser.profile*` wscompat relay channels
**Service:** `agent/` (Dev Server Agent) — no backend-go changes; `channels_browser_profiles.go`'s relay wiring is already correct and complete
**File:** `agent/src/relay/browser-handler.ts`, `agent/src/relay/agent-rpc-dispatch-browser.ts`, `agent/src/relay/browser-handler.test.ts`, `agent/src/relay/agent-rpc-dispatch-browser.test.ts`
**Depends on:** none
**Status:** `[x]` DONE — implemented as specified; confirmed `agent-browser`'s real vendored CLI (`node_modules/agent-browser/bin/agent-browser.js cookies --help`) does have `cookies clear`/`cookies set` with the exact flags SOL-009 cited. No `agent-rpc-dispatch-browser.test.ts` existed yet, so it was created fresh (no prior file to extend) covering routing, error-mapping, and the "no longer falls through to default" case. `npx vitest run` (27/27 pass) and `npx tsc --noEmit` (zero new errors in the two touched files; 131 pre-existing unrelated errors elsewhere in the repo, none in these files) both clean.

---

## Context

BUG-009 confirmed `channels_browser_profiles.go` already relays
`browser.profileClearDefaultCookies` correctly (resolves `devServerId ->
connectionId`, calls `Relay`) but the agent's dispatch switch has no case
for it — it falls through to `default: return null`
(`agent-rpc-dispatch-browser.ts:206-207`), which the caller turns into a
generic "method not handled" error. SOL-009 identifies this as the
trivial one of the three missing methods: the vendored `agent-browser`
CLI already has a first-class `cookies clear` command, so this is a
direct instance of the same `dispatchBrowserCommand` pattern every
sibling `browser.*` handler already uses (e.g. `handleBrowserKeypress`,
`browser-handler.ts:327-333`).

**The one real design question this task must resolve before wiring the
CLI call:** every other `browser.*` op is scoped by `params.worktree` via
`requireWorktreeId` (`browser-handler.ts:172-178`), because `agent-browser`
sessions are per-worktree (`--session <worktreeId>`). But
`channels_browser_profiles.go`'s relay is keyed by `devServerId`, not
`worktree` (confirmed: `registerBrowserProfileRelay`'s `relayArgs` struct
is `{ DevServerID string }` only — `channels_browser_profiles.go:107-116`
— "no worktree involved... a profile is dev-server-scoped," per that
file's own comment). So the wire params this handler receives carry no
`worktree` field at all, and `requireWorktreeId`/`dispatchBrowserCommand`
cannot be reused unmodified.

**Decision for this task:** treat "the default cookies" as the
dev-server-wide default `agent-browser` session, using a fixed session
name distinct from any worktree id (e.g. `"__default__"` — pick a value
that cannot collide with a real worktree id, which are UUIDs/opaque ids
elsewhere in this codebase; confirm against how worktree ids are actually
shaped before hardcoding, but a reserved, syntactically-invalid-as-a-real-id
sentinel is the safest choice). This does not require a new
`dispatchBrowserCommand` variant — it requires calling
`runBrowserCommand` directly with that fixed session name instead of one
derived from `params.worktree`.

## Changes to make

### 1. `browser-handler.ts` — new handler

Add after the existing handlers (following the file's own `// ─── browser.X
───` section-divider convention, e.g. after `handleBrowserTabClose`,
`browser-handler.ts:426-472`):

```ts
// ─── browser.profileClearDefaultCookies ─────────────────────────────────────

// Why: this relay is keyed by devServerId, not worktree
// (channels_browser_profiles.go's registerBrowserProfileRelay carries no
// worktree field) — "the default cookies" means the dev-server-wide
// default agent-browser session, not any one worktree's session. Uses a
// fixed session name reserved for this purpose, distinct from any real
// worktree id, so this never collides with (or accidentally clears) an
// active worktree's browser session.
const DEFAULT_BROWSER_PROFILE_SESSION = '__default_browser_profile__'

export async function handleBrowserProfileClearDefaultCookies(
  id: JsonRpcId,
  _params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    await runBrowserCommand(DEFAULT_BROWSER_PROFILE_SESSION, ['cookies', 'clear'])
    return makeSuccess(id, { cleared: true }) // matches BrowserProfileClearDefaultCookiesResult.cleared
                                               // (frontend/src/shared/runtime-types.ts:883-885)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileClearDefaultCookies failed: ${message}`)
    return makeFailure(id, message)
  }
}
```

This does not use `dispatchBrowserCommand` (which calls
`requireWorktreeId(params)` internally) because there is no worktree
param on this wire call — it calls `runBrowserCommand` directly with the
fixed session name, matching `runBrowserCommand`'s existing exported
signature (`worktreeId: string, args: string[]`,
`browser-handler.ts:184`) which doesn't actually require its first
argument to be a real worktree id, just a stable `agent-browser --session`
key.

### 2. `agent-rpc-dispatch-browser.ts` — new case

Add before the `default:` fallthrough (`agent-rpc-dispatch-browser.ts:206-207`),
matching every sibling case's exact shape (e.g. the `browser.keypress`
case):

```ts
case 'browser.profileClearDefaultCookies': {
  try {
    const { handleBrowserProfileClearDefaultCookies } = await import('./browser-handler')
    return (await handleBrowserProfileClearDefaultCookies(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeError(rpc.id, AgentErrorCode.ServerError, `browser.profileClearDefaultCookies unavailable: ${msg}`)
  }
}
```

### 3. Tests

`browser-handler.test.ts` (extend): mock `execFile`/`execFileAsync` the
same way existing tests mock `runBrowserCommand`'s underlying call (check
an existing test for `handleBrowserKeypress` or similar for the exact
mock plumbing), assert:
- The CLI is invoked with `['cookies', 'clear', '--session',
  '__default_browser_profile__', '--json']` (or whatever the finalized
  constant is) — i.e., **not** derived from any `params.worktree`.
- Success path returns `{ cleared: true }`.
- A CLI failure returns `makeFailure` with the propagated message.

`agent-rpc-dispatch-browser.test.ts` (extend): assert
`dispatchBrowserRpc({ method: 'browser.profileClearDefaultCookies', ... })`
calls `handleBrowserProfileClearDefaultCookies` and no longer falls
through to `default: return null`.

## Verify

```bash
cd agent
npx vitest run src/relay/browser-handler.test.ts src/relay/agent-rpc-dispatch-browser.test.ts
npx tsc --noEmit
```

Expected: new/extended tests pass; zero new `tsc` errors in the two
touched files (the repo has pre-existing, unrelated `tsc` errors
elsewhere — confirm none appear in `browser-handler.ts`/
`agent-rpc-dispatch-browser.ts` specifically, per the precedent set in
`specs/backend-go/bugs/missing-v1/tasks/TASK-036-document-browser-agent-driving-gap.md`).
