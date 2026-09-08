# BUG-011: `git.cancelGenerateCommitMessage` / `git.cancelGeneratePullRequestFields` not implemented — and backend-go's dispatch model has nothing for them to cancel

**Service:** `api-gateway` (WS compat layer) / `git-gateway-service`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go`
**Severity:** Low — best-effort UX only. A missing cancel does not corrupt state or block the
UI; it just means an in-flight AI-generation call runs to completion (up to the frontend's own
75s timeout) instead of being interrupted early.
**Status:** Open — genuine gap, but flagged as architecturally non-trivial, not a quick wiring win.

---

## What's missing

`git.generateCommitMessage` and `git.generatePullRequestFields` ARE registered
(`channels_git.go:102-115`, `:643-...`) and call `git-gateway-service`'s
`GenerateCommitMessage`/`GeneratePullRequestFields` RPCs. Their cancel counterparts are not:

```
grep -n '"git\.cancel' backend-go/services/api-gateway/internal/adapter/wscompat/*.go
```

returns zero matches. Both fall through to `notImplementedHandler`. Frontend call sites:
`frontend/src/renderer/src/runtime/runtime-git-client.ts:635-652`
(`cancelRuntimeGenerateCommitMessage` → `git.cancelGenerateCommitMessage`) and
`:690-707` (`cancelRuntimeGeneratePullRequestFields` → `git.cancelGeneratePullRequestFields`),
both routed with `target.kind !== 'local'` and a real `worktreeId`.

## Why this is a real gap, but a structurally awkward one to fix

Read `git.generateCommitMessage`'s full path:

- `channels_git.go:102-115`: the WS handler decodes args, then does one **synchronous**
  `client.GenerateCommitMessage(ctx, ...)` gRPC call and returns whatever comes back (or the
  error). `ctx` here is the single WS request's own request-scoped context.
- `git-gateway-service/internal/adapter/grpc/server.go:296`: the gRPC handler.
- `git-gateway-service/internal/usecase/generate_commit_message.go:34`:
  `(uc *GenerateCommitMessage) Execute(ctx context.Context, in GenerateCommitMessageInput)
  (string, error)` — a plain synchronous call into an `AICompleter`, no job ID, no ticket, no
  background goroutine, nothing persisted anywhere that a second, independent WS request could
  reference.

This is backend-go's normal dispatch model — **every** `wscompat` channel is one
synchronous request/response round trip per WS message; there is no background-job registry
anywhere in the gateway (confirmed: grepped `wscompat/*.go` for `context.WithCancel`/
`CancelFunc` — the only hits are `channels_ai_provider.go`'s per-call `context.WithTimeout`
convenience wrapper and the `terminal.*` files' PTY session lifecycle, neither of which is a
"cancel an unrelated in-flight request by some external key" mechanism).

So `git.cancelGenerateCommitMessage`/`cancelGeneratePullRequestFields`, if wired naively as
"just another channel," would have **nothing to attach to**: the in-flight
`generateCommitMessage` call is a different WS message/goroutine already blocked inside its
own gRPC call, and there is no `worktreeId → context.CancelFunc` (or similar) registry a
sibling `cancel*` handler could look up and invoke. Building one would require:

1. A per-connection (or per-tenant+worktree) map from an in-flight generate call to its
   `context.CancelFunc`, populated when `git.generateCommitMessage`/
   `generatePullRequestFields` starts and cleared when it finishes.
2. The cancel channel looking that entry up by `worktreeId` and calling `cancel()`.
3. `git-gateway-service`'s `AICompleter` actually honoring context cancellation mid-call
   (plausible if it's a normal HTTP-based LLM client respecting `ctx`, but unverified here —
   worth checking before assuming cancellation would even propagate correctly).

None of that infrastructure exists today. This is squarely a **capability gap**, not a
5-line wiring fix like most of this directory's other findings — closer in shape to
"needs new design" than "just missing a `r.Register` call."

## Severity note

Confirmed low-impact: the frontend's own worst case if this stays unimplemented is that a
user who clicks "regenerate"/navigates away mid-generation still burns the full up-to-75s
AI call server-side instead of it stopping early — wasted AI-provider quota/latency, not a
correctness or data-integrity issue. `cancelRuntimeGenerateCommitMessage`/
`cancelRuntimeGeneratePullRequestFields` themselves would just get a `notImplementedHandler`
error today if called against an environment target — worth confirming the frontend
swallows/tolerates that error at the call site rather than surfacing it as a hard failure,
but that's a frontend-side follow-up, not this report's finding.

## Owning service verdict

`git-gateway-service`, mirroring `generateCommitMessage`/`generatePullRequestFields`'s own
ownership — but this needs new cancellation-tracking design in `api-gateway`'s `wscompat`
layer (or a job-ticket concept added to `git-gateway-service` itself) before a channel can
be usefully wired, not just a channel registration.

---

## Status update (TASK-031/TASK-032/TASK-033)

Resolved. TASK-031 added a narrow, worktree+kind-keyed `gitGenerateCancelRegistry` in
`wscompat` (`git_generate_cancellation.go`); TASK-032 wrapped
`git.generateCommitMessage`/`generatePullRequestFields` with a cancellable `context.WithCancel`
registered into it, and wired `git.cancelGenerateCommitMessage`/`cancelGeneratePullRequestFields`
to look up and invoke the registered `CancelFunc`. Both are implemented, tested (including
`-race`), and registered in `registerGitDeepChannels`.

TASK-033 corrects this report's own open question #3 above: `git-gateway-service`'s
`AICompleter` is **not** a raw HTTP client to an LLM provider — it is `RelayExecutor`
(`internal/adapter/grpcclient/relay_executor.go`), whose `Complete` method relays to the
Dev Server Agent's own `ai.complete` RPC via `relay()`, which passes the caller's `ctx`
straight into `r.client.Relay`/`RelayByDevServer`. Context cancellation from `wscompat`'s
new cancel channels **does** propagate correctly through every layer `backend-go` owns —
there was no missing `http.NewRequestWithContext`-style fix needed inside
`git-gateway-service` itself. The only remaining open question is agent-side (whether the
Dev Server Agent's `ai.complete` handler itself selects on the relay stream's cancellation
alongside its own outbound LLM call) — out of this `backend-go`-only investigation's scope.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go:102-115` — `git.generateCommitMessage` (registered, synchronous)
- `backend-go/services/git-gateway-service/internal/adapter/grpc/server.go:296` — `GenerateCommitMessage` gRPC handler
- `backend-go/services/git-gateway-service/internal/usecase/generate_commit_message.go:30-34` — synchronous `Execute`, no job/ticket concept
- `frontend/src/renderer/src/runtime/runtime-git-client.ts:635-652,690-707` — both cancel call sites
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ai_provider.go:33` — the only other `context.CancelFunc` usage in `wscompat`, a per-call timeout, not a cancel registry
- `backend-go/services/api-gateway/internal/adapter/wscompat/git_generate_cancellation.go` — TASK-031's registry
- `backend-go/services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go:929-937` — `Complete`, TASK-033's corrected finding
