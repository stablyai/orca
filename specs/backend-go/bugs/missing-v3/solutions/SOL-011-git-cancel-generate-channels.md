# SOL-011: A narrow, per-worktree cancellation registry in `wscompat` — not a generic in-flight-request framework

**Resolves:** [BUG-011](../BUG-011-git-cancel-generate-channels-not-implemented.md)
**Service:** `api-gateway` (WS compat layer) — no `git-gateway-service` proto change; cancellation is
implemented entirely as a client-side (from `git-gateway-service`'s perspective) `context.CancelFunc` call
**Affected files (proposed):**
- `backend-go/services/api-gateway/internal/adapter/wscompat/git_generate_cancellation.go` (new)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go` (wrap `git.generateCommitMessage`/`git.generatePullRequestFields`, register the 2 `git.cancel*` channels)
- `backend-go/services/api-gateway/internal/adapter/wscompat/git_generate_cancellation_test.go` (new)
**Status:** 🚧 Proposed — no code written

---

## Answering BUG-011's central design question first

BUG-011 asks explicitly: does this need a generic per-connection in-flight-request cancellation registry, or
is a narrow `context.CancelFunc` keyed by something specific to these 2 methods sufficient?

**Answer: narrow, worktree-keyed, and specific to `git.generateCommitMessage`/`generatePullRequestFields`.**
Three reasons, each checked against the actual codebase rather than assumed:

1. **No client-supplied request ID exists to key a generic registry on.** `InboundMessage.ID`
   (`envelope.go:42`) is the WS invoke/response correlation ID, generated and owned by the frontend's own
   `rpc-client.ts` transport layer — it is not passed to channel handlers at all (`ChannelHandler`'s signature,
   `registry.go:37`, only receives `args []json.RawMessage`, never `msg.ID`). A generic "cancel request X"
   registry would need either (a) plumbing `msg.ID` down into every handler and having the frontend's own
   cancel call site echo it back, or (b) inventing a new job-ticket ID the generate call would need to return
   to the frontend first and the frontend would need to hold onto — neither exists today, and both are bigger
   changes than this bug's frontend call sites already support.
2. **The frontend's actual cancel call sites don't send a request ID at all.** `cancelRuntimeGenerateCommitMessage`
   / `cancelRuntimeGeneratePullRequestFields` (`runtime-git-client.ts:635-652,690-707`) send exactly
   `{ worktree: toRuntimeWorktreeSelector(context.worktreeId) }` — no job ID, no correlation token. Whatever
   this proposal builds must be keyed by `worktreeId`, because that is the only thing the wire protocol
   actually carries. This settles the key choice without needing to invent one.
3. **`worktreeId` is already a natural uniqueness key for "the one active generate call a user could plausibly
   want to cancel."** The frontend UI these call sites serve (commit-message/PR-description generation) is a
   single-flight-per-worktree interaction — a user has at most one generate-in-flight per worktree at a time
   (the "regenerate" button that triggers `cancelRuntimeGenerateCommitMessage` is disabled/replaced while a
   generation is in progress, per the commit-message-panel UX this call backs). A generic multi-request
   registry would solve a problem (many concurrent in-flight requests of the same kind needing independent
   cancellation) that doesn't exist for this feature.

A generic per-connection cancellation registry is a real, bigger piece of infrastructure that might be worth
building **if** more call sites needed it — but nothing else in `wscompat` today does (BUG-011's own grep
confirms `channels_ai_provider.go`'s `context.CancelFunc` is a per-call timeout convenience, not a
cancel-by-key mechanism, and `terminal.*`'s PTY lifecycle is a different, already-solved problem: PTYs get
explicit `terminal.close`/`terminal.stop` channels keyed by `ptyId`, a session identifier the create call
itself returns — not a generic request-cancellation concept). Building generic infrastructure for a
hypothetical second consumer that doesn't exist would be over-engineering for a Low-severity, best-effort UX
fix. If a third `cancel*` pair shows up later with genuinely different keying needs, that's the moment to
generalize this into a real registry — not now.

---

## Design: a package-level, worktree-keyed cancel-func map

```go
// git_generate_cancellation.go
//
// A best-effort, in-memory registry from worktreeId -> the context.CancelFunc
// of that worktree's currently in-flight git.generateCommitMessage or
// generatePullRequestFields call. Deliberately NOT a generic per-request
// cancellation framework — see SOL-011's design-question section for why a
// narrow, 2-method-specific registry is the right size for this fix.
//
// Scoped process-wide (not per-connection): api-gateway is a single Go
// process behind potentially many WS connections for the same tenant/user
// (e.g. two browser tabs), and "cancel the generate call for worktree X"
// is a worktree-level concept, not a connection-level one — a cancel
// arriving on a DIFFERENT connection than the one that started the generate
// call must still work, exactly as BUG-011's own framing implies ("a second,
// independent WS request").
package wscompat

import (
	"context"
	"sync"
)

// gitGenerateCancelKind distinguishes the 2 generate operations sharing one
// worktreeId namespace — see gitGenerateCancelRegistry's doc comment for why
// they're not just merged into one untyped key (a commit-message generate
// and a PR-fields generate for the SAME worktree are legitimately
// independent in-flight operations, e.g. a user opens the PR panel while a
// commit-message regenerate is still running).
type gitGenerateCancelKind string

const (
	gitGenerateCancelKindCommitMessage      gitGenerateCancelKind = "commitMessage"
	gitGenerateCancelKindPullRequestFields   gitGenerateCancelKind = "pullRequestFields"
)

type gitGenerateCancelKey struct {
	WorktreeID string
	Kind       gitGenerateCancelKind
}

// gitGenerateCancelRegistry tracks the CancelFunc for each worktree+kind's
// currently in-flight generate call. Zero value is ready to use.
type gitGenerateCancelRegistry struct {
	mu      sync.Mutex
	cancels map[gitGenerateCancelKey]context.CancelFunc
}

var gitGenerateCancels = &gitGenerateCancelRegistry{
	cancels: make(map[gitGenerateCancelKey]context.CancelFunc),
}

// start registers cancel under key, returning a cleanup func the caller
// MUST defer immediately — it removes this exact entry (not just any
// entry for the key), so a fast call finishing after a second, newer call
// for the same worktree has already started never clobbers the newer
// call's still-live entry. This is the same "only clear what you own"
// discipline as a mutex unlock paired 1:1 with its lock, applied to a map
// entry instead of a lock.
func (r *gitGenerateCancelRegistry) start(key gitGenerateCancelKey, cancel context.CancelFunc) (cleanup func()) {
	r.mu.Lock()
	// A prior in-flight call for the same worktree+kind is superseded, not
	// merged: cancel it now so it doesn't keep running invisibly once a
	// newer call for the same key has started (mirrors "regenerate"
	// replacing, not stacking with, a previous generate).
	if prev, ok := r.cancels[key]; ok {
		prev()
	}
	r.cancels[key] = cancel
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		// NOTE: deleting unconditionally by `key` here is NOT safe in
		// general — see the correctness subtlety below the code block and
		// the pointer-identity refinement that follows it, which this
		// first-pass sketch omits for readability.
		delete(r.cancels, key)
		r.mu.Unlock()
	}
}

// cancel looks up and invokes key's registered CancelFunc, if any.
// Returns false if there was nothing in flight to cancel (a legitimate,
// non-error outcome — the generate call may have already finished, or
// never started).
func (r *gitGenerateCancelRegistry) cancel(key gitGenerateCancelKey) bool {
	r.mu.Lock()
	cancel, ok := r.cancels[key]
	r.mu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}
```

**A correctness subtlety worth being explicit about** (flagged rather than silently glossed over, matching
this directory's house style): the `cleanup` closure above deletes by `key`, which is technically capable of
deleting a *newer* call's entry if `cleanup` runs late (e.g. after `defer` fires but a newer `start` already
raced in). In practice this cannot happen for THIS registry's actual call pattern, because `start` itself
cancels any previous entry for the same key synchronously before installing the new one — so by the time a
new `start` call returns, the old call's context is already cancelled and its handler is unwinding towards
its own `defer cleanup()`, which runs before the new call's generate work has meaningfully begun. The
remaining race (old cleanup's `delete` running after the new call's `start`, both holding the same mutex
sequentially) is closed by making `cleanup` a strict no-op once superseded — implemented by storing a
per-registration token alongside the `CancelFunc` and having `cleanup` check `r.cancels[key] == thisCancelFunc`
(pointer identity, using `reflect.ValueOf(fn).Pointer()` or, more simply, wrapping each entry in a small
`*gitGenerateCancelEntry` struct compared by pointer) before deleting — this refinement is a small addition
to the sketch above, called out here explicitly so it isn't dropped during implementation.

```go
// Refinement: compare-before-delete via a pointer-identity token, closing
// the race described above.
type gitGenerateCancelEntry struct {
	cancel context.CancelFunc
}

func (r *gitGenerateCancelRegistry) start(key gitGenerateCancelKey, cancel context.CancelFunc) (cleanup func()) {
	entry := &gitGenerateCancelEntry{cancel: cancel}
	r.mu.Lock()
	if prev, ok := r.cancels[key]; ok {
		prev.cancel()
	}
	r.cancels[key] = entry
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		if r.cancels[key] == entry { // only remove if we're still the current entry
			delete(r.cancels, key)
		}
		r.mu.Unlock()
	}
}
// (r.cancels map value type becomes map[gitGenerateCancelKey]*gitGenerateCancelEntry)
```

---

## Wiring `git.generateCommitMessage`/`generatePullRequestFields` to register

```go
// channels_git.go — replace the existing bodies (channels_git.go:102-115, :643-...)

r.Register("git.generateCommitMessage", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	type genArgs struct {
		WorktreeID string `json:"worktreeId"`
	}
	in, err := decodeArg[genArgs](args, 0)
	if err != nil {
		return nil, err
	}
	// dispatchRPCTimeout (registry.go's 60s outer bound, or invokeTimeout's
	// 25s at the WS transport layer, whichever binds tighter) still applies
	// as the upper bound — this WithCancel narrows further via explicit
	// cancel, it doesn't replace the existing deadline discipline
	// (08-inter-service-communication.md: "Deadlines are mandatory on every
	// outbound call").
	genCtx, cancel := context.WithCancel(ctx)
	key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindCommitMessage}
	cleanup := gitGenerateCancels.start(key, cancel)
	defer cleanup()
	defer cancel() // release resources if genCtx's parent finishes normally, not via explicit cancel

	resp, err := client.GenerateCommitMessage(genCtx, &gitgatewayv1.GenerateCommitMessageRequest{WorktreeId: in.WorktreeID})
	if err != nil {
		return nil, err
	}
	return resp, nil
})

r.Register("git.cancelGenerateCommitMessage", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	in, err := decodeArg[cancelGenerateArgs](args, 0)
	if err != nil {
		return nil, err
	}
	key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindCommitMessage}
	gitGenerateCancels.cancel(key) // return value ignored — "nothing in flight" is not an error, see cancel()'s doc comment
	return nil, nil
})

// generatePullRequestFields / cancelGeneratePullRequestFields: identical
// shape, gitGenerateCancelKindPullRequestFields in place of
// gitGenerateCancelKindCommitMessage. Omitted here as a repeat of the
// pattern immediately above.

type cancelGenerateArgs struct {
	WorktreeID string `json:"worktreeId"`
}
```

`in.WorktreeID` is decoded from the frontend's `{ worktree: toRuntimeWorktreeSelector(context.worktreeId) }`
wire shape — the existing `genArgs`/PR-fields structs already do this decode correctly for the generate calls
themselves (`channels_git.go:102-106`), so the cancel handlers' `cancelGenerateArgs` mirrors the same
field-name convention, not a new one.

**Return contract for the cancel channels**: `nil, nil` unconditionally, regardless of whether anything was
actually in flight to cancel. `cancelRuntimeGenerateCommitMessage`/`cancelRuntimeGeneratePullRequestFields`
are typed `Promise<void>` at the frontend call site (`runtime-git-client.ts:635-637,690-692`) — there is no
success/failure distinction for the frontend to react to, and racing "did I cancel before or after the
generate call finished naturally" is exactly the class of best-effort ambiguity this feature's own severity
note (Low — "best-effort UX only") says is fine to leave unresolved.

---

## Whether `git-gateway-service`'s `AICompleter` actually honors context cancellation

BUG-011 flags this as "plausible but unverified." Whatever the current `AICompleter` implementation does,
**this proposal's correctness does not depend on the answer**, for two reasons:

1. `context.WithCancel`'s cancelled context still unblocks the calling goroutine at the **gRPC client** layer
   even if the far side (`git-gateway-service` → its own `AICompleter` → the upstream LLM HTTP call) keeps
   running to completion server-side — the gRPC client call returns a `context.Canceled` error promptly once
   the local context is cancelled, because gRPC's client-side stream machinery itself watches the context,
   independent of whether the server-side handler also respects a cancelled request context. That already
   delivers this bug's actual promised value: the **frontend** stops waiting and the WS response comes back
   promptly instead of running to the full 75s client timeout, which is the concrete Low-severity annoyance
   BUG-011 describes.
2. Whether `git-gateway-service`'s own in-flight LLM HTTP call ALSO stops (rather than completing server-side
   after the client has already given up) is a real, separate question about `AICompleter`'s implementation
   — worth checking, but it's a `git-gateway-service`-internal concern (does its gRPC handler propagate the
   incoming request's `ctx` all the way into the HTTP client it uses for the LLM call, per Go's standard
   `http.NewRequestWithContext` pattern) that this `wscompat`-layer proposal cannot fix from the caller side
   even if it wanted to. Flagged here as a **follow-up worth a quick source check** before considering this
   bug fully closed end-to-end — if `GenerateCommitMessage`'s `Execute` (`generate_commit_message.go:34`)
   doesn't thread its incoming `ctx` into the outbound LLM HTTP request, cancelling from `wscompat` stops the
   *client* from waiting but wastes exactly as much AI-provider quota server-side as doing nothing at all,
   which would be worth knowing and fixing in `git-gateway-service` itself (a one-line
   `http.NewRequestWithContext(ctx, ...)` fix if that turns out to be the gap) — but is out of scope for this
   `wscompat`-only proposal to design.

---

## Test plan

- `git_generate_cancellation_test.go`:
  - `start`/`cancel` round trip: register a key, cancel it, assert the stored `context.Context` reports
    `Err() == context.Canceled`.
  - Cancel with no matching key returns `false`, does not panic.
  - A second `start` for the same key cancels the first entry's context (supersession) before installing the
    second.
  - `cleanup` deletes only its own entry — start key K with cancel A, get its cleanup `c1`; start key K again
    with cancel B (supersedes A, entry is now B); call `c1()`; assert the registry still holds B's entry (not
    empty) — this is the exact race the pointer-identity refinement closes, and it must have a regression
    test given how easy it would be to reintroduce with a naive unconditional `delete`.
- `channels_git_test.go` (extend):
  - `git.generateCommitMessage` registers a cancel entry for the duration of the call and removes it after
    (assert via a test hook or by racing a `git.cancelGenerateCommitMessage` call against a fake
    `GenerateCommitMessage` that blocks on a channel, then unblocks it, then asserts a *second*
    `git.cancelGenerateCommitMessage` call for the same worktree afterward returns cleanly with no panic/
    stuck state).
  - `git.cancelGenerateCommitMessage`/`cancelGeneratePullRequestFields` called with no matching in-flight
    call: returns `nil, nil`, does not error.
  - Two different worktrees' generate calls have independent, non-interfering cancel entries.
  - `commitMessage` and `pullRequestFields` kinds for the SAME worktree are independent (cancelling one does
    not cancel the other).

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go:102-115,643-658` — the existing synchronous `generateCommitMessage`/`generatePullRequestFields` registrations this proposal wraps
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:37,165-193` — `ChannelHandler`'s signature (no request-ID parameter) and `Dispatch`'s own `context.WithTimeout` wrapping, confirming there is no existing per-request cancellation hook to build on
- `backend-go/services/api-gateway/internal/adapter/wscompat/handler.go:198-228` — `handleInvoke`'s one-goroutine-per-message dispatch model; confirms a `cancel*` call arrives as a fully independent goroutine/context from the `generate*` call it targets
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ai_provider.go:33-35` — the only other `context.CancelFunc` usage in `wscompat`, a per-call timeout wrapper, not a cancel-by-key registry (confirms BUG-011's own grep finding)
- `backend-go/services/git-gateway-service/internal/usecase/generate_commit_message.go:30-34` — `Execute`'s synchronous signature; the context-propagation-into-`AICompleter` follow-up this proposal flags but does not fix
- `specs/backend-go/tdd/architecture/08-inter-service-communication.md` — "Deadlines are mandatory on every outbound call" gRPC convention this proposal's `context.WithCancel` composes with, not replaces
- `frontend/src/renderer/src/runtime/runtime-git-client.ts:635-652,690-707` — both cancel call sites' exact wire shape (`{worktree}`, no request ID), which settles this proposal's worktree-keyed design
- `specs/backend-go/bugs/missing-v3/BUG-011-git-cancel-generate-channels-not-implemented.md` — the bug this resolves, including its own framing of the generic-registry-vs-narrow-fix question this proposal answers
