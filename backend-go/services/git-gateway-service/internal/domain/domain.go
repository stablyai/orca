// Package domain holds git-gateway-service's value objects. Per
// specs/backend-go/services/git-gateway-service.md §4, this package is
// deliberately light: value objects mirrored from the Dev Server Agent's
// wire protocol / local `git` output, not invariant-bearing entities — this
// service owns no persistent state to protect invariants over (§5, §6). No
// type here has a constructor that enforces a git invariant (e.g. "a commit
// must have a valid SHA") because this service never constructs a commit —
// it only relays and reflects what the Dev Server Agent or local `git`
// binary already produced.
package domain

import "errors"

// ErrForceDeleteBranchUnsupported is returned when the relay target's Dev
// Server Agent build predates a force-delete-branch method — the
// operational counterpart to GitExecutor.ForceDeleteBranch's compile-time
// guarantee (every implementation must have the method; this is "the
// method call fails cleanly" for an outdated agent build), per BUG-031's
// cited old-TS fallback comment ("older SSH relays predate
// git.forceDeletePreservedBranch").
//
// Lives in domain, not internal/adapter/grpcclient, deliberately: TASK-194
// Step 4's usecase.ForceDeleteBranch needs to check errors.Is against this
// sentinel, and internal/adapter/grpcclient already imports internal/usecase
// (for the port interfaces it implements) — usecase importing grpcclient
// back for just this sentinel would be a real import cycle. domain has no
// dependency on either package, so both grpcclient (which returns this
// error) and usecase (which checks it) can import domain safely.
var ErrForceDeleteBranchUnsupported = errors.New("git-gateway-service: relay target does not support force-delete-branch")

// ErrConflictResolveUnsupportedOverRelay is returned when ResolveConflict is
// called against a relay-connected (SSH) worktree — the real agent's
// git.exec whitelist for Part B (the surface RelayExecutor's SSH-relay
// calls reach) explicitly excludes both `checkout` and `add`
// (specs/agent/api/agent-rpc-catalog-git-fs.md:203-227's "Not allowed at
// all" list), so there is no whitelisted way to compose ours/theirs/
// markResolved remotely. Same operational-fallback shape as
// ErrForceDeleteBranchUnsupported above — lives in domain so both
// grpcclient (which returns it) and usecase (which checks it via
// errors.Is) can import it without an import cycle.
var ErrConflictResolveUnsupportedOverRelay = errors.New("git-gateway-service: relay target does not support per-file conflict resolution")

// FileState enumerates the file-status values git-gateway-service's wire
// protocol carries (mirrors the generated proto's FileStatus.state string
// per gitgateway.proto's comment: "modified/added/deleted/untracked/conflicted").
// Kept as a string-backed type with a Valid() check rather than a
// constructor-enforced entity — this is the one "meaningfully pure" piece of
// validation logic this package has, per the design doc's guidance that a
// minimal domain package with just types is fine otherwise.
type FileState string

const (
	FileStateModified   FileState = "modified"
	FileStateAdded      FileState = "added"
	FileStateDeleted    FileState = "deleted"
	FileStateUntracked  FileState = "untracked"
	FileStateConflicted FileState = "conflicted"
	FileStateRenamed    FileState = "renamed"
)

// Valid reports whether s is one of the known file-status states.
func (s FileState) Valid() bool {
	switch s {
	case FileStateModified, FileStateAdded, FileStateDeleted, FileStateUntracked, FileStateConflicted, FileStateRenamed:
		return true
	default:
		return false
	}
}

// FileStatus is one file's position in `git status` output — path plus its
// state, translated 1:1 from either local `git status --porcelain` parsing
// or the Dev Server Agent's git.status JSON response.
type FileStatus struct {
	Path  string
	State FileState
}

// GitStatus is a worktree's full status: current branch plus its file list.
// Ahead/behind counts and a conflict flag are part of the design doc's
// sketch (§4) but are not part of the current generated proto surface
// (GetStatusResponse only carries files+branch); add them here alongside
// the corresponding proto fields if/when that RPC surface grows.
type GitStatus struct {
	Branch string
	Files  []FileStatus
}

// DiffResult is a unified-diff text blob returned by GetDiff — this service
// does not parse the diff into hunks (§2: "does not parse diffs beyond
// what's needed to pass them through"), it passes through whatever the
// local `git diff` binary or Dev Server Agent produced.
type DiffResult struct {
	UnifiedDiff string
}

// CommitResult holds the SHA produced by a Commit operation.
type CommitResult struct {
	CommitSHA string
}

// PushResult reflects whether a Push operation succeeded.
type PushResult struct {
	Success bool
}

// PullResult reflects whether a Pull operation succeeded, and whether it
// left the worktree with unresolved conflicts.
type PullResult struct {
	Success      bool
	HadConflicts bool
}

// SimpleResult is the bare-success-flag shape shared by Stage/Unstage
// (TASK-208) and Fetch — any operation with no richer result than
// "did it work".
type SimpleResult struct {
	Success bool
}

// CommitRef is one commit's metadata, returned by History. Mirrors
// gitgateway.proto's CommitRef message 1:1.
type CommitRef struct {
	SHA        string
	Author     string
	Committer  string
	Message    string
	Timestamp  int64
	ParentSHAs []string
}

// GitChangeEntry is one changed file's status within a CommitCompare/
// BranchCompare result — mirrors parseBranchDiff's {path, status, oldPath?,
// added?, removed?} entry shape (agent/src/relay/git-handler-utils.ts:107-134,
// parseBranchStatusChar:15-30, agent/src/shared/git-uncommitted-line-stats.ts:56-76).
type GitChangeEntry struct {
	Path    string
	Status  string // "modified" | "added" | "deleted" | "renamed" | "copied"
	OldPath string
	Added   int
	Removed int
}

// CommitCompareResult mirrors the real agent's git.commitCompare response
// (agent/src/relay/git-handler-commit-diff-ops.ts:15-122,
// specs/agent/api/agent-rpc-catalog-git-fs.md:50/144): a commit diffed
// against its own parent (or the empty tree, for a root commit) — NOT two
// arbitrary commits, which TASK-209's original design incorrectly assumed.
// ParentOID is empty for a root commit (diffed against the empty tree).
type CommitCompareResult struct {
	CommitOID    string
	ParentOID    string
	CompareRef   string
	BaseRef      string
	ChangedFiles int
	Status       string // "ready" | "invalid-commit" | "error"
	ErrorMessage string
	Entries      []GitChangeEntry
}

// BranchCompareResult mirrors the real agent's git.branchCompare response
// (agent/src/relay/git-handler-ops.ts:124-214,
// specs/agent/api/agent-rpc-catalog-git-fs.md:49/143): current HEAD diffed
// against ONE baseRef's merge-base — NOT two arbitrary branches, which
// TASK-209's original design incorrectly assumed.
type BranchCompareResult struct {
	BaseRef      string
	BaseOID      string
	CompareRef   string
	HeadOID      string
	MergeBase    string
	ChangedFiles int
	CommitsAhead int
	Status       string // "ready" | "invalid-base" | "unborn-head" | "no-merge-base" | "loading" | "error"
	ErrorMessage string
	Entries      []GitChangeEntry
}

// FileDiffResult is a single file's before/after content — the real agent's
// git.commitDiff/git.branchDiff response shape (buildDiffResult,
// agent/src/relay/git-diff-result.ts:5-38), NOT a unified-diff text blob
// like DiffResult (GetDiff's shape, see that type's own doc comment) — the
// real agent composes these two ops from raw blob reads at each ref, not
// `git diff`'s textual output. See CommitDiff/BranchDiff's GitExecutor doc
// comments in ports.go for why this needed a different domain type than
// GetDiff's DiffResult.
type FileDiffResult struct {
	Kind             string // "text" | "binary"
	OriginalContent  string
	ModifiedContent  string
	OriginalIsBinary bool
	ModifiedIsBinary bool
	IsImage          bool
	MimeType         string
}

// ForkSyncStatus reflects a worktree's ahead/behind/diverged state relative
// to its upstream fork's default branch.
type ForkSyncStatus struct {
	Ahead    int
	Behind   int
	Diverged bool
}

// UpstreamStatus reflects whether the current branch has a configured
// upstream and its ahead/behind counts if so.
type UpstreamStatus struct {
	HasUpstream bool
	Ahead       int
	Behind      int
}

// WorktreeCreateResult is what a successful `git worktree add` reports.
type WorktreeCreateResult struct {
	Path    string
	HeadSHA string
}

// WorktreeGitInfo is one entry from `git worktree list --porcelain` — path
// plus enough git-level identity (HEAD sha, branch) for DetectWorktrees to
// build a real reconciled worktree record without a second git invocation
// per path. Branch is "" for a detached HEAD (the porcelain output's own
// `detached` line, not a `branch <ref>` one).
type WorktreeGitInfo struct {
	Path   string
	Head   string
	Branch string
}

// WorktreeResult is CreateWorktree's usecase-level result: the saga's
// combined answer once both the git operation and project-service's
// bookkeeping record have succeeded.
type WorktreeResult struct {
	WorktreeID string
	Path       string
	HeadSHA    string
}

// RepoInfo is project-service's answer to "does this repo exist, what
// project/URL does it belong to, and which dev server does it live on" —
// the shape the worktree usecases need to validate a repo id and dispatch
// a git operation against it (see dispatchExecutorForRepo in
// usecase/ports.go).
//
// Deviation from TASK-193's original sketch, since corrected: project.proto's
// Repo message itself still has no dev_server_id/path field (project.repos
// has no such column — Repo.URL doubles as an absolute filesystem path for
// repos set up via SetupExistingFolder/ImportNested, see those usecases'
// doc comments). DevServerID here comes from project.proto's GetRepo RPC
// resolving it through the repo's OWNING PROJECT instead (ProjectService.
// GetRepoResponse.dev_server_id) — a second, project-service-side lookup
// this service doesn't need to make itself.
type RepoInfo struct {
	ID          string
	ProjectID   string
	URL         string
	DisplayName string
	DevServerID string
	// HiddenTargetID (TASK-BE-EVM-015, BE-SOL-EVM-004 §4's decision 3) is a
	// routing attribute ORTHOGONAL to DevServerID/URL — set only for a repo
	// living on a `ssh`-type ephemeral VM's hidden target (Hướng A,
	// TASK-BE-EVM-014), never a new "host" for ResolveConnection. Empty for
	// every other repo (the common case), same "empty means unaffected"
	// convention DevServerID already uses just above.
	//
	// TASK-BE-EVM-018 (BE-SOL-EVM-004 §6c) added the wire field
	// (project.proto's GetRepoResponse.hidden_target_id) and this struct's
	// client-side mapping (grpcclient.ProjectClient.GetRepo) for real — but
	// project-service's OWN GetRepo handler does not populate a real value
	// yet (which ephemeral VM runtime, if any, backs a given repo_id is an
	// infra-fleet-service-owned fact — that cross-service join is a
	// follow-up, see TASK-BE-EVM-015's "Kết quả thực tế" gap #2 for the
	// full audit). A repo-scoped fs/git dispatch still always sees "" here
	// until that join lands.
	HiddenTargetID string
}

// EphemeralVmRecipe mirrors frontend/src/shared/types.ts's OrcaVmRecipe — a
// repo-authored orca.yaml `environmentRecipes[]` entry naming the shell
// commands that provision/suspend/resume/destroy a per-workspace ephemeral
// VM/container. This service never runs these commands itself (Group 1 is
// read-only) — see usecase.EphemeralVmRelay (TASK-004) for the lifecycle
// half that does.
type EphemeralVmRecipe struct {
	ID              string
	Name            string
	Description     string
	Create          string
	Suspend         string
	Resume          string
	Destroy         string
	DestroyDisabled bool
}

// WorktreeRecord mirrors project-service's Worktree message — the
// bookkeeping row RecordWorktreeCreated/SetWorktreeActivation return.
type WorktreeRecord struct {
	ID     string
	Path   string
	Branch string
}

// WorktreeLineageCapture is optional lineage-capture context CreateWorktree
// forwards to project-service's RecordWorktreeCreated — see
// proto/orca/project/v1/project.proto's WorktreeLineageEntry doc comment
// for what each field means. Every field empty means "no lineage captured",
// the common case; project-service (not this service) decides
// CaptureConfidence from whether any of these are set.
type WorktreeLineageCapture struct {
	ParentWorktreeID        string
	Origin                  string
	CaptureSource           string
	TaskID                  string
	OrchestrationRunID      string
	CoordinatorHandle       string
	CreatedByTerminalHandle string
}

// ResolvedBase is PrefetchCreateBase/ResolvePrBase/ResolveMrBase's answer:
// a base branch name plus the local SHA it resolved to once fetched.
type ResolvedBase struct {
	Branch string
	SHA    string
}

// ── Group A — branch/ref operations (TASK-207) ─────────────────────────────

// BranchInfo is one local branch's tracking state, returned by
// ListLocalBranches. Mirrors gitgateway.proto's BranchInfo message 1:1 —
// see that message's doc comment for why this is richer than the real
// agent's own git.localBranches response.
type BranchInfo struct {
	Name      string
	Upstream  string
	Ahead     int
	Behind    int
	IsCurrent bool
	IsRemote  bool
}

// CheckoutResult reflects a Checkout operation's outcome.
type CheckoutResult struct {
	Success bool
	Branch  string
}

// PushTargetInput mirrors the real agent's GitPushTarget wire shape
// (agent/src/shared/types.ts:551-557) — see gitgateway.proto's
// PushTargetInput message doc comment for the full citation. Used by
// FastForward, UpstreamStatus, and Fetch (TASK-209/210's own contract
// corrections) — Push/Pull still take the open pushTarget redesign as a
// follow-up (see grpcclient.RelayExecutor's Push/Pull "KNOWN LIMITATION"
// comments), not resolved by this pass.
type PushTargetInput struct {
	RemoteName    string
	BranchName    string
	RemoteURL     string
	RemoteCreated bool
}

// FastForwardResult reflects whether a FastForward operation succeeded.
type FastForwardResult struct {
	Success bool
}

// RebaseResult reflects whether a RebaseFromBase operation succeeded, and
// whether it left the worktree with unresolved conflicts — mirrors
// PullResult's Success/HadConflicts shape for the same reason (a conflict
// is a real domain outcome, not a Go error).
type RebaseResult struct {
	Success      bool
	HadConflicts bool
}

// BulkDiscardResult reports partial failure across a multi-path discard —
// see BulkDiscardRequest's proto doc comment for why this isn't
// all-or-nothing.
type BulkDiscardResult struct {
	Success     bool
	FailedPaths []string
}
