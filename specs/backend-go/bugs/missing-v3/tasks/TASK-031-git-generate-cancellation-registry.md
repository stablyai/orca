# TASK-031: Add a narrow, worktree+kind-keyed cancellation registry for `git.generateCommitMessage`/`generatePullRequestFields`

**From Solution:** SOL-011
**Priority:** P0 — do first; TASK-032 wires the two `generate*`/`cancel*` channel pairs against this registry and cannot be written without it existing
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/git_generate_cancellation.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/git_generate_cancellation_test.go` (new)
**Depends on:** none
**Status:** `[x]` DONE — as specified. `go build`/`go vet`/`go test -run TestGitGenerateCancelRegistry -race` all clean (race-detector-clean, per this task's own correctness bar).

---

## Context

BUG-011 found `git.cancelGenerateCommitMessage`/`git.cancelGeneratePullRequestFields`
unregistered, and — more importantly — found that backend-go's `wscompat` dispatch
model has **nothing for a cancel channel to attach to**: every channel is one
synchronous request/response round trip per WS message/goroutine, with no
background-job registry anywhere in the gateway. SOL-011 answers BUG-011's own central
design question ("generic per-connection cancellation framework, or a narrow fix?")
explicitly: **narrow, worktree-keyed, and specific to these 2 methods** — there is no
client-supplied request ID to key a generic registry on (`ChannelHandler`'s signature,
`registry.go:37`, never receives the WS envelope's own `msg.ID`), and the frontend's
actual cancel call sites (`runtime-git-client.ts:635-652,690-707`) send exactly
`{worktree: ...}`, no job ID — so `worktreeId` is the only key the wire protocol
actually carries, and it's already a natural one (one active generate-in-flight per
worktree at a time, matching the commit-message/PR-description UI's own
single-flight-per-worktree design).

## Changes to make

### Step 1 — create `git_generate_cancellation.go`

```go
// A best-effort, in-memory registry from (worktreeId, kind) -> the
// context.CancelFunc of that worktree's currently in-flight
// git.generateCommitMessage or generatePullRequestFields call.
// Deliberately NOT a generic per-request cancellation framework — see
// SOL-011 (specs/backend-go/bugs/missing-v3/solutions/) for why a narrow,
// 2-method-specific registry is the right size for this fix: there is no
// client-supplied request ID anywhere in this package's wire protocol to
// key a generic registry on, and the frontend's actual cancel call sites
// only ever send {worktree}, never a job ticket.
//
// Scoped process-wide (not per-connection): api-gateway is a single Go
// process behind potentially many WS connections for the same
// tenant/user (e.g. two browser tabs), and "cancel the generate call for
// worktree X" is a worktree-level concept, not a connection-level one — a
// cancel arriving on a DIFFERENT connection than the one that started the
// generate call must still work.
package wscompat

import (
	"context"
	"sync"
)

// gitGenerateCancelKind distinguishes the 2 generate operations sharing
// one worktreeId namespace — a commit-message generate and a PR-fields
// generate for the SAME worktree are legitimately independent in-flight
// operations (e.g. a user opens the PR panel while a commit-message
// regenerate is still running), so they are not merged into one untyped
// key.
type gitGenerateCancelKind string

const (
	gitGenerateCancelKindCommitMessage     gitGenerateCancelKind = "commitMessage"
	gitGenerateCancelKindPullRequestFields gitGenerateCancelKind = "pullRequestFields"
)

type gitGenerateCancelKey struct {
	WorktreeID string
	Kind       gitGenerateCancelKind
}

// gitGenerateCancelEntry wraps a CancelFunc so cleanup can compare by
// pointer identity (see start's doc comment) rather than deleting a map
// entry unconditionally by key.
type gitGenerateCancelEntry struct {
	cancel context.CancelFunc
}

// gitGenerateCancelRegistry tracks the CancelFunc for each worktree+kind's
// currently in-flight generate call. Zero value is ready to use.
type gitGenerateCancelRegistry struct {
	mu      sync.Mutex
	cancels map[gitGenerateCancelKey]*gitGenerateCancelEntry
}

var gitGenerateCancels = &gitGenerateCancelRegistry{
	cancels: make(map[gitGenerateCancelKey]*gitGenerateCancelEntry),
}

// start registers cancel under key, returning a cleanup func the caller
// MUST defer immediately. cleanup removes ONLY its own entry (compared by
// pointer identity, not just by key) — a fast call finishing after a
// second, newer call for the same worktree+kind has already started must
// never clobber the newer call's still-live entry. This is the same
// "only clear what you own" discipline as a mutex unlock paired 1:1 with
// its lock, applied to a map entry instead of a lock.
//
// A prior in-flight call for the same key is superseded, not merged:
// cancel it immediately so it doesn't keep running invisibly once a newer
// call for the same key has started (mirrors "regenerate" replacing, not
// stacking with, a previous generate). Because start cancels the
// previous entry SYNCHRONOUSLY before installing the new one, by the time
// a new start call returns, the old call's context is already cancelled
// and its handler is unwinding towards its own deferred cleanup — closing
// the only realistic window for the delete-the-wrong-entry race the
// pointer-identity check guards against.
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

// cancel looks up and invokes key's registered CancelFunc, if any. Returns
// false if there was nothing in flight to cancel — a legitimate,
// non-error outcome: the generate call may have already finished, or
// never started.
func (r *gitGenerateCancelRegistry) cancel(key gitGenerateCancelKey) bool {
	r.mu.Lock()
	entry, ok := r.cancels[key]
	r.mu.Unlock()
	if !ok {
		return false
	}
	entry.cancel()
	return true
}
```

### Step 2 — tests (`git_generate_cancellation_test.go`)

```go
package wscompat

import (
	"context"
	"testing"
)

func TestGitGenerateCancelRegistry_StartThenCancel(t *testing.T) {
	r := &gitGenerateCancelRegistry{cancels: make(map[gitGenerateCancelKey]*gitGenerateCancelEntry)}
	key := gitGenerateCancelKey{WorktreeID: "wt-1", Kind: gitGenerateCancelKindCommitMessage}
	ctx, cancel := context.WithCancel(context.Background())
	cleanup := r.start(key, cancel)
	defer cleanup()

	if !r.cancel(key) {
		t.Fatal("want cancel to find and invoke the registered entry")
	}
	if ctx.Err() != context.Canceled {
		t.Errorf("want the registered context to report Canceled, got %v", ctx.Err())
	}
}

func TestGitGenerateCancelRegistry_CancelWithNoMatch(t *testing.T) {
	r := &gitGenerateCancelRegistry{cancels: make(map[gitGenerateCancelKey]*gitGenerateCancelEntry)}
	if r.cancel(gitGenerateCancelKey{WorktreeID: "nope", Kind: gitGenerateCancelKindCommitMessage}) {
		t.Fatal("want false for a key that was never registered")
	}
}

func TestGitGenerateCancelRegistry_SecondStartSupersedesFirst(t *testing.T) {
	r := &gitGenerateCancelRegistry{cancels: make(map[gitGenerateCancelKey]*gitGenerateCancelEntry)}
	key := gitGenerateCancelKey{WorktreeID: "wt-1", Kind: gitGenerateCancelKindCommitMessage}

	ctxA, cancelA := context.WithCancel(context.Background())
	_ = r.start(key, cancelA)

	ctxB, cancelB := context.WithCancel(context.Background())
	_ = r.start(key, cancelB)

	if ctxA.Err() != context.Canceled {
		t.Errorf("want the FIRST call's context cancelled once superseded, got %v", ctxA.Err())
	}
	if ctxB.Err() != nil {
		t.Errorf("want the SECOND (current) call's context still live, got %v", ctxB.Err())
	}
}

// TestGitGenerateCancelRegistry_CleanupOnlyRemovesOwnEntry is the exact
// race the pointer-identity refinement closes — regression test required
// per SOL-011's own test plan given how easy this would be to
// reintroduce with a naive unconditional `delete(r.cancels, key)`.
func TestGitGenerateCancelRegistry_CleanupOnlyRemovesOwnEntry(t *testing.T) {
	r := &gitGenerateCancelRegistry{cancels: make(map[gitGenerateCancelKey]*gitGenerateCancelEntry)}
	key := gitGenerateCancelKey{WorktreeID: "wt-1", Kind: gitGenerateCancelKindCommitMessage}

	_, cancelA := context.WithCancel(context.Background())
	cleanupA := r.start(key, cancelA)

	_, cancelB := context.WithCancel(context.Background())
	r.start(key, cancelB) // supersedes A; registry now holds B's entry

	cleanupA() // A's late cleanup must be a no-op now

	if _, ok := r.cancels[key]; !ok {
		t.Fatal("want B's entry to still be present — A's stale cleanup must not have deleted it")
	}
}

func TestGitGenerateCancelRegistry_CommitMessageAndPullRequestFieldsAreIndependent(t *testing.T) {
	r := &gitGenerateCancelRegistry{cancels: make(map[gitGenerateCancelKey]*gitGenerateCancelEntry)}
	commitCtx, commitCancel := context.WithCancel(context.Background())
	prCtx, prCancel := context.WithCancel(context.Background())
	r.start(gitGenerateCancelKey{WorktreeID: "wt-1", Kind: gitGenerateCancelKindCommitMessage}, commitCancel)
	r.start(gitGenerateCancelKey{WorktreeID: "wt-1", Kind: gitGenerateCancelKindPullRequestFields}, prCancel)

	r.cancel(gitGenerateCancelKey{WorktreeID: "wt-1", Kind: gitGenerateCancelKindCommitMessage})

	if commitCtx.Err() != context.Canceled {
		t.Error("want commitMessage cancelled")
	}
	if prCtx.Err() != nil {
		t.Error("want pullRequestFields NOT cancelled by a commitMessage-only cancel for the same worktree")
	}
}
```

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestGitGenerateCancelRegistry -v -count=1 -race
```

`-race` is worth including explicitly here (even though this package's other tests
don't always specify it) — this file's whole reason to exist is a `sync.Mutex`-guarded
map accessed from concurrent goroutines (a `generate*` handler's own goroutine and a
`cancel*` handler's independent one, per `handler.go:198-228`'s one-goroutine-per-message
model), so a race-detector-clean result is this task's actual correctness bar.
