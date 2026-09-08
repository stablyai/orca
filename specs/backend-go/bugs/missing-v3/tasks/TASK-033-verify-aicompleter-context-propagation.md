# TASK-033: Document `git-gateway-service`'s real `AICompleter` context-propagation path — corrects SOL-011's "HTTP client" framing

**From Solution:** SOL-011
**Priority:** P2 — a documentation-only follow-up SOL-011 explicitly flags as out of scope for its own `wscompat`-only proposal; not a `wscompat` code change and not blocking TASK-031/TASK-032
**Service:** `git-gateway-service`
**File:** `specs/backend-go/bugs/missing-v3/BUG-011-git-cancel-generate-channels-not-implemented.md` (status note only); no source change
**Depends on:** none (independent of TASK-031/TASK-032; can be read/verified separately)
**Status:** `[x]` DONE — as specified. Re-verified `RelayExecutor.Complete`/`relay` against the real current source (line numbers matched exactly); added a "Status update" section to `BUG-011`'s own file recording the corrected finding and pointing to TASK-031/TASK-032 as the actual fix. No source change, as specified.

---

## Context

SOL-011 flags a real, separate question after designing the `wscompat`-side
cancellation registry (TASK-031/TASK-032): does `git-gateway-service`'s own
`AICompleter` actually stop its outbound LLM call when the caller's `ctx` is
cancelled, or does cancelling from `wscompat` only stop the **client** from waiting
while the work keeps running server-side and burning AI-provider quota for nothing?
SOL-011's own text guesses this might be a gap in an `http.NewRequestWithContext`
call inside `git-gateway-service`. **That guess turns out to be based on an
inaccurate picture of `AICompleter`'s real implementation** — worth correcting here
rather than carrying the wrong mental model into a future fix attempt.

## What the real code actually does (verified, not guessed)

`git-gateway-service` has no direct outbound HTTP call to an LLM API at all.
`GenerateCommitMessage.Execute` (`internal/usecase/generate_commit_message.go:30-34`,
verbatim) calls `uc.completer.Complete(ctx, ...)`, where `AICompleter` is implemented
by `RelayExecutor` (`internal/adapter/grpcclient/relay_executor.go`) — its doc comment
states this plainly: *"It also implements usecase.AICompleter (see Complete below) via
the same Relay RPC with method 'ai.complete'."* The real `Complete` method (verbatim,
`relay_executor.go:929-937`):

```go
func (r *RelayExecutor) Complete(ctx context.Context, connectionID, prompt string) (string, error) {
	var result struct {
		Content string `json:"content"`
	}
	err := r.relay(ctx, connectionID, "ai.complete", map[string]any{
		"prompt": prompt,
	}, &result)
	return result.Content, err
}
```

`relay` (verbatim, `relay_executor.go:63-...`) passes `ctx` straight into either
`r.client.Relay(ctx, ...)` or `r.client.RelayByDevServer(ctx, ...)` — both real gRPC
client calls. **This means context cancellation IS already correctly propagated all
the way from `wscompat`'s `git.cancelGenerateCommitMessage` (TASK-032) through
`git-gateway-service`'s usecase layer into the actual outbound gRPC call to
infra-fleet-service.** There is no missing `http.NewRequestWithContext` fix to make in
`git-gateway-service` itself — SOL-011's speculative fix target doesn't exist, because
`git-gateway-service` was never making a raw HTTP call to an LLM provider in the first
place; it relays to the Dev Server Agent's own `ai.complete` RPC.

## The real remaining open question — one level further down than SOL-011 thought

The only genuinely open question is now **agent-side**, not `git-gateway-service`-side:
once `RelayByDevServer`'s underlying gRPC stream is cancelled client-side, does the Dev
Server Agent's own `ai.complete` handler notice and stop its own outbound LLM HTTP call
mid-flight, or does the agent keep running to completion even though nothing is
listening for the result anymore? That is `agent/`-side implementation code, out of
this bug's (and this whole `missing-v3` pass's) `backend-go`-only scope — the same kind
of boundary this investigation pass already respects elsewhere (e.g. TASK-030's
`terminal.create`/`openGhAuthTerminal` blocker, SOL-010's `agent/`-scoped RPCs).

This does not change TASK-031/TASK-032's correctness or value: cancelling from
`wscompat` still delivers BUG-011's actual promised value (the frontend stops waiting
and the WS response comes back promptly instead of running to the full 75s client
timeout) regardless of what the agent does with the now-abandoned relay server-side.

## Changes to make

**No `backend-go` source change.** This task's only concrete output:

1. Add a note to `BUG-011`'s file (or a follow-up line in this task) recording the
   corrected finding above, so a future reader doesn't waste time looking for an
   `http.NewRequestWithContext` fix inside `git-gateway-service` that isn't the actual
   gap.
2. If/when this is investigated further, the right place to check is the Dev Server
   Agent's `ai.complete` handler (`agent/`, out of this pass's scope) — specifically
   whether it selects on the incoming relay stream's own cancellation/context alongside
   its outbound LLM HTTP call, the same `select { case <-ctx.Done(): ...; case
   result := <-llmCall: ... }` shape any Go server handling a slow downstream call
   under an upstream deadline would need.

## Verify

No build/test verification applies — this task corrects a design document's stated
assumption against the real source, it does not change behavior. To re-confirm the
finding independently at pickup time:

```bash
cd backend-go
grep -n "func (r \*RelayExecutor) Complete" -A 10 services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go
grep -n "func (r \*RelayExecutor) relay(" -A 20 services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go
```

Expected: `Complete` passes its `ctx` parameter into `r.relay(ctx, ...)`, and `relay`
passes that same `ctx` into `r.client.Relay(ctx, ...)`/`r.client.RelayByDevServer(ctx,
...)` — confirming cancellation propagation is already correct at every layer
`backend-go` owns.
