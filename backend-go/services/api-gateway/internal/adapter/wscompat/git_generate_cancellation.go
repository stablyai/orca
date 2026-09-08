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
