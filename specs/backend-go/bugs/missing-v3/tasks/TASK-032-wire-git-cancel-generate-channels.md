# TASK-032: Wrap `git.generateCommitMessage`/`generatePullRequestFields` with cancellable contexts and register `git.cancelGenerateCommitMessage`/`cancelGeneratePullRequestFields`

**From Solution:** SOL-011
**Priority:** P0 — the actual bug fix; depends on TASK-031's registry existing
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git_test.go`
**Depends on:** TASK-031 (needs `gitGenerateCancels`/`gitGenerateCancelKey`/`gitGenerateCancelKind*` to exist)
**Status:** `[x]` DONE — as specified. `go build`/`go vet`/`go test -run TestGit -race` clean for this task's own tests and the whole `TestGit*`/`TestOnboarding*` subset; the full-package `-race` run separately surfaces one pre-existing, unrelated data race in `channels_browser_screencast_test.go` (a different task's test code, not touched by this task) — not introduced by this change, left as-is and flagged for whoever owns that file.

---

## Context

`git.generateCommitMessage` and `git.generatePullRequestFields` are registered and
call `git-gateway-service`'s RPCs synchronously; their `cancel*` counterparts are
unregistered (BUG-011). This task makes the two `generate*` handlers register their
own cancellation into TASK-031's registry for the duration of their call, and adds the
2 `cancel*` handlers that look a worktree+kind up in that registry and cancel it.
Neither `generateCommitMessage`/`generatePullRequestFields`'s own handler bodies need
any change beyond the cancellable-context wrapping below — they don't need to know
anything about cancellation themselves; only the WS-layer wrapper does.

## Changes to make

### Step 1 — `git.generateCommitMessage`: real current code (verbatim, `channels_git.go:102-115`)

```go
	r.Register("git.generateCommitMessage", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type genArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[genArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GenerateCommitMessage(ctx, &gitgatewayv1.GenerateCommitMessageRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
```

Replace with:

```go
	r.Register("git.generateCommitMessage", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type genArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[genArgs](args, 0)
		if err != nil {
			return nil, err
		}
		// genCtx is independently cancellable via
		// git.cancelGenerateCommitMessage (a second, independent WS
		// request/goroutine) — see git_generate_cancellation.go (TASK-031).
		// dispatchRPCTimeout (registry.go's 60s outer bound) still applies as
		// the upper bound; this WithCancel narrows further via explicit
		// cancel, it doesn't replace that deadline.
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
```

### Step 2 — `git.generatePullRequestFields`: real current code (verbatim, `channels_git.go:643-659`)

```go
	r.Register("git.generatePullRequestFields", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type genPRFieldsArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseBranch string `json:"baseBranch"`
		}
		in, err := decodeArg[genPRFieldsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GeneratePullRequestFields(ctx, &gitgatewayv1.GeneratePullRequestFieldsRequest{
			WorktreeId: in.WorktreeID, BaseBranch: in.BaseBranch,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
```

Replace with:

```go
	r.Register("git.generatePullRequestFields", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type genPRFieldsArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseBranch string `json:"baseBranch"`
		}
		in, err := decodeArg[genPRFieldsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		genCtx, cancel := context.WithCancel(ctx)
		key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindPullRequestFields}
		cleanup := gitGenerateCancels.start(key, cancel)
		defer cleanup()
		defer cancel()

		resp, err := client.GeneratePullRequestFields(genCtx, &gitgatewayv1.GeneratePullRequestFieldsRequest{
			WorktreeId: in.WorktreeID, BaseBranch: in.BaseBranch,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.cancelGeneratePullRequestFields", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[cancelGenerateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindPullRequestFields}
		gitGenerateCancels.cancel(key)
		return nil, nil
	})
```

Both new registrations belong in `registerGitDeepChannels` alongside the handlers they
wrap — `git.cancelGenerateCommitMessage` immediately after `git.generateCommitMessage`
(TASK-206 section), `git.cancelGeneratePullRequestFields` immediately after
`git.generatePullRequestFields` (TASK-211 section, real current code at the end of
`registerGitDeepChannels`, right before its closing `}` at line 674).

### Step 3 — shared `cancelGenerateArgs` type

Add once near the top of `channels_git.go` (not inside either handler — both `cancel*`
handlers share it):

```go
// cancelGenerateArgs mirrors cancelRuntimeGenerateCommitMessage/
// cancelRuntimeGeneratePullRequestFields's exact wire shape
// (runtime-git-client.ts:635-652,690-707: {worktree: toRuntimeWorktreeSelector(...)}) —
// same field-name convention the generate calls' own genArgs/genPRFieldsArgs already use.
type cancelGenerateArgs struct {
	WorktreeID string `json:"worktreeId"`
}
```

**Return contract for both cancel channels**: `nil, nil` unconditionally, regardless of
whether anything was actually in flight to cancel. Both frontend call sites are typed
`Promise<void>` with no success/failure distinction to react to, and racing "did I
cancel before or after the generate call finished naturally" is exactly the
best-effort ambiguity BUG-011's own severity note (Low) says is fine to leave
unresolved.

### Step 4 — tests (`channels_git_test.go`, extend)

The existing `fakeGitGatewayClient` (verbatim current, `channels_git_test.go:25,105-106,132-133`)
already exposes `generateCommitMessageFunc`/`generatePullRequestFieldsFunc` fields —
reuse them, don't add new fake fields:

```go
func TestGitCancelGenerateCommitMessage_CancelsInFlightCall(t *testing.T) {
	started := make(chan struct{})
	fake := &fakeGitGatewayClient{
		generateCommitMessageFunc: func(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	errCh := make(chan error, 1)
	go func() {
		_, err := r.Dispatch(context.Background(), Identity{}, "git.generateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
		errCh <- err
	}()
	<-started

	_, err := r.Dispatch(context.Background(), Identity{}, "git.cancelGenerateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error from cancel: %v", err)
	}

	if genErr := <-errCh; genErr == nil {
		t.Fatal("want the in-flight generate call to fail once cancelled")
	}

	// A second cancel for the same, now-finished worktree must be a clean no-op.
	_, err = r.Dispatch(context.Background(), Identity{}, "git.cancelGenerateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("second cancel: unexpected error: %v", err)
	}
}

func TestGitCancelGenerateCommitMessage_NoInFlightCallIsCleanNoOp(t *testing.T) {
	r := NewRegistry()
	registerGitDeepChannels(r, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{}, "git.cancelGenerateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "no-such-worktree"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGitCancelGeneratePullRequestFields_DoesNotCancelCommitMessage(t *testing.T) {
	commitStarted := make(chan struct{})
	commitCtx := make(chan context.Context, 1)
	fake := &fakeGitGatewayClient{
		generateCommitMessageFunc: func(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
			commitCtx <- ctx
			close(commitStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	go r.Dispatch(context.Background(), Identity{}, "git.generateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	<-commitStarted

	// Cancelling pullRequestFields for the SAME worktree must not touch the
	// independent commitMessage in-flight call.
	_, _ = r.Dispatch(context.Background(), Identity{}, "git.cancelGeneratePullRequestFields", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))

	select {
	case ctx := <-commitCtx:
		if ctx.Err() != nil {
			t.Fatal("want commitMessage's context still live — pullRequestFields cancel must not affect it")
		}
	default:
		t.Fatal("expected to have captured the in-flight commitMessage context")
	}
}
```

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestGit -v -count=1 -race
```
