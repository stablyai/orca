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
