package grpcclient

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/usecase"
)

// RelayExecutor implements usecase.GitExecutor and usecase.FilesystemExecutor
// for the connected-host case (ConnectionResolver reports Connected=true),
// by calling infra-fleet-service's generic Relay RPC with method names like
// "git.status" / "fs.readFile" and JSON-encoded params, per
// git-gateway-service.md §2 step 3'. It also implements usecase.AICompleter
// (see Complete below) via the same Relay RPC with method "ai.complete",
// for GenerateCommitMessage/GeneratePullRequestFields.
//
// Param/result field names below are reconciled against
// specs/agent/api/agent-rpc-catalog-git-fs.md's real Dev Server Agent
// contract (worktreePath, filePath, etc.) per TASK-227/TASK-228/BUG-036 —
// see each method's own doc comment for known gaps that remain (blocked
// shape redesigns, methods still needing TASK-227 for reachability).
type RelayExecutor struct {
	client infrafleetv1.InfraFleetServiceClient
}

// NewRelayExecutor wraps an already-constructed infrafleetv1 client — used
// with Dial's connection (resolver.go) in cmd/server/main.go, and with a
// fake client in tests.
func NewRelayExecutor(client infrafleetv1.InfraFleetServiceClient) *RelayExecutor {
	return &RelayExecutor{client: client}
}

// relay marshals params and calls infra-fleet-service's agent-execution
// plane for connectionID/method, unmarshalling the result into out.
//
// Fixed gap (was: "Threading ConnectionID through GitExecutor's signature
// is the real fix; not done here"): usecase.GitExecutor's methods still
// only receive repoPath, not a resolved connectionId — but repoPath was
// never a valid infra.connections.id to begin with (a filesystem path
// can't satisfy that column's uuid type), so passing it as Relay's
// ConnectionId could never have resolved for ANY caller, live-confirmed as
// this exact call's own root cause (INFRA_RESOLVE_FAILED, once dispatch
// finally started reaching here at all — see PollFleetHealth's commit for
// why it never had before). dispatchExecutorForRepo now threads the repo's
// dev server id through ctx (usecase.WithDevServerID) instead: when
// present, call RelayByDevServer — infra-fleet-service's purpose-built
// bypass for "reach this dev server's agent before any infra.connections
// row exists for it" (see usecase.RelayByDevServer's own doc comment,
// infra-fleet-service) — rather than the connectionId-keyed Relay RPC.
// dispatchExecutor's worktree-keyed callers (e.g. RemoveWorktree) don't set
// this and still fall through to Relay with repoPath-as-connectionId; that
// path is currently moot (infra.connections has zero rows system-wide, so
// ConnectionResolver.ResolveConnection there always answers
// Connected=false today) but remains a separate, still-open gap, not fixed
// in this pass.
func (r *RelayExecutor) relay(ctx context.Context, connectionID, method string, params map[string]any, out any) error {
	// TASK-BE-EVM-015 (BE-SOL-EVM-004 §4's decision 3): a repo living on a
	// ssh-type ephemeral VM's hidden target routes through a DIFFERENT
	// agent method name (mirroring ExecViaHiddenSshTarget's
	// "*ViaHiddenTarget" convention, TASK-BE-EVM-014) carrying hiddenTargetId
	// as an extra param — same devServer/agent session as any other repo on
	// this Dev Server (dispatchExecutorForRepo/dispatchFilesystemExecutorForRepo
	// already resolved that via WithDevServerID above this call), no new
	// transport, no new provider_registry_entries value. This is read from
	// ctx (WithHiddenTargetID), not a new parameter, for the exact reason
	// DevServerIDFromContext already reads from ctx here: relay is the ONE
	// shared chokepoint every GitExecutor/FilesystemExecutor method (~52 of
	// them) already funnels through, so this covers all of them without
	// widening any of their signatures.
	if hiddenTargetID, ok := usecase.HiddenTargetIDFromContext(ctx); ok {
		method += "ViaHiddenTarget"
		if params == nil {
			params = map[string]any{}
		}
		params["hiddenTargetId"] = hiddenTargetID
	}

	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return err
	}

	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("grpcclient: marshal params for %s: %w", method, err)
	}

	var resultJSON string
	if devServerID, ok := usecase.DevServerIDFromContext(ctx); ok {
		resp, err := r.client.RelayByDevServer(ctx, &infrafleetv1.RelayByDevServerRequest{
			DevServerId: devServerID,
			Method:      method,
			ParamsJson:  string(paramsJSON),
		})
		if err != nil {
			return fmt.Errorf("grpcclient: relayByDevServer %s: %w", method, err)
		}
		resultJSON = resp.GetResultJson()
	} else {
		resp, err := r.client.Relay(ctx, &infrafleetv1.RelayRequest{
			ConnectionId: connectionID,
			Method:       method,
			ParamsJson:   string(paramsJSON),
		})
		if err != nil {
			return fmt.Errorf("grpcclient: relay %s: %w", method, err)
		}
		resultJSON = resp.GetResultJson()
	}

	// Bug found live (2026-09-02/03, worktree-create-fix follow-up): a
	// JSON-RPC-shaped error response from the agent (e.g. handleGitWorktreeAdd's
	// validation failures) arrives here as a perfectly normal gRPC "ok" —
	// RelayByDevServer/Relay only fail at the gRPC layer for transport/session
	// problems, never for the agent's own {jsonrpc, error:{...}} responses.
	// Every caller of relay() (52 methods) was silently treating that shape as
	// success: out==nil skipped inspecting resultJSON entirely, and even a
	// non-nil out just leaves its zero value on a shape mismatch (Go's
	// json.Unmarshal doesn't error on missing fields). Concretely: CreateWorktree's
	// first call (git.worktree.add, out=nil) swallowed the real failure, then its
	// follow-up rev-parse call failed for an unrelated reason (targetPath never
	// existed) — the ONLY error that ever surfaced was that second, misleading one.
	// Check for the embedded error unconditionally, before the out==nil shortcut.
	//
	// Code is json.Number, not string: the real agent's AgentErrorCode is a
	// JSON-RPC numeric code (e.g. -32000, -33003 — agent/src/shared/agent-wire-protocol.ts).
	// An earlier version of this fix typed Code as string, which made
	// json.Unmarshal fail (number into a string field) on every real error
	// envelope — silently falling through to "no error" again, the exact
	// bug this block exists to close. Caught before ever reaching a live
	// worktree.create retry; covered by TestRelayExecutor_Stat_AgentErrorEnvelope_NumericCode.
	var envelope struct {
		Error *struct {
			Code    json.Number `json:"code"`
			Message string      `json:"message"`
		} `json:"error"`
	}
	if resultJSON != "" {
		if unmarshalErr := json.Unmarshal([]byte(resultJSON), &envelope); unmarshalErr == nil && envelope.Error != nil {
			return fmt.Errorf("grpcclient: agent rejected %s: %s (%s)", method, envelope.Error.Message, envelope.Error.Code)
		}
	}

	if out == nil || resultJSON == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(resultJSON), out); err != nil {
		return fmt.Errorf("grpcclient: unmarshal %s result: %w", method, err)
	}
	return nil
}

// ── usecase.GitExecutor ───────────────────────────────────────────────────

func (r *RelayExecutor) GetStatus(ctx context.Context, repoPath string) (domain.GitStatus, error) {
	var result domain.GitStatus
	err := r.relay(ctx, repoPath, "git.status", map[string]any{
		"worktreePath": repoPath, // was "repoPath" — real agent contract, see BUG-036/TASK-228
	}, &result)
	return result, err
}

func (r *RelayExecutor) GetDiff(ctx context.Context, repoPath, filePath string, staged bool) (domain.DiffResult, error) {
	var result domain.DiffResult
	err := r.relay(ctx, repoPath, "git.diff", map[string]any{
		"worktreePath": repoPath, "filePath": filePath, "staged": staged,
	}, &result)
	return result, err
}

func (r *RelayExecutor) Commit(ctx context.Context, repoPath, message string, paths []string) (domain.CommitResult, error) {
	var result domain.CommitResult
	// NOTE: "paths" is sent but the real agent ignores it — commit assumes
	// pre-staged content (via a prior git.stage/git.bulkStage call, see
	// TASK-208). Left in the wire payload for now rather than silently
	// dropping the Go signature's paths param — harmless either way.
	err := r.relay(ctx, repoPath, "git.commit", map[string]any{
		"worktreePath": repoPath, "message": message,
	}, &result)
	return result, err
}

func (r *RelayExecutor) Push(ctx context.Context, repoPath, remote, branch string) (domain.PushResult, error) {
	var result domain.PushResult
	// KNOWN LIMITATION: real agent wants a structured pushTarget, not bare
	// remote/branch (SOL-032 §0 open question #1, unresolved). This param
	// shape may be rejected by the agent's shape validator or bypass
	// fork-branch push safety. Do not consider Push "fixed" until the
	// pushTarget redesign lands.
	err := r.relay(ctx, repoPath, "git.push", map[string]any{
		"worktreePath": repoPath, "remote": remote, "branch": branch,
	}, &result)
	return result, err
}

func (r *RelayExecutor) Pull(ctx context.Context, repoPath string) (domain.PullResult, error) {
	var result domain.PullResult
	// Same pushTarget limitation as Push above.
	err := r.relay(ctx, repoPath, "git.pull", map[string]any{
		"worktreePath": repoPath,
	}, &result)
	return result, err
}

// Stage always relays to "git.bulkStage", never "git.stage" — the real
// agent's git.stage is single-file only (no repeated-paths support), but
// git.bulkStage accepts any count ≥1, so it's a strict superset that
// covers both the single-file (stage) and multi-select (bulkStage)
// frontend call sites without branching on len(paths). See SOL-032 §0 /
// TASK-208's Contract correction section.
func (r *RelayExecutor) Stage(ctx context.Context, repoPath string, paths []string) (domain.SimpleResult, error) {
	var result domain.SimpleResult
	err := r.relay(ctx, repoPath, "git.bulkStage", map[string]any{
		"worktreePath": repoPath, "filePaths": paths,
	}, &result)
	return result, err
}

// CreateWorktree: fixed method name (was "git.worktreeAdd" — a typo; the
// agent only registers the dotted "git.worktree.add", matching its
// worktree.remove/worktree.list siblings) and param shape (the agent's
// handleGitWorktreeAdd reads params.path as the NEW worktree's destination
// directory and params.cwd as the EXISTING repo root to run from — not a
// single "repoPath" — and has no response body beyond git.exec's raw
// {stdout,stderr,exitCode}, so path/HeadSHA must be computed/fetched here,
// not unmarshalled from the agent's reply). targetPath mirrors
// localgit.Executor.CreateWorktree's own convention (repoPath + "-" +
// sanitized branch) so both host paths agree on where a worktree lands.
// createBranch is always true: CreateWorktreeInput/the usecase layer has no
// "checkout an existing branch" signal — this call always represents the
// "Create worktree" UI flow's new-branch intent, same as localgit's own
// CreateWorktree which unconditionally passes `-b`.
func (r *RelayExecutor) CreateWorktree(ctx context.Context, repoPath, branch, baseRef string) (domain.WorktreeCreateResult, error) {
	targetPath := repoPath + "-" + sanitizeBranchForRelayPath(branch)

	params := map[string]any{
		"path":         targetPath,
		"branch":       branch,
		"createBranch": true,
		"cwd":          repoPath,
	}
	if baseRef != "" {
		params["baseRef"] = baseRef
	}
	if err := r.relay(ctx, repoPath, "git.worktree.add", params, nil); err != nil {
		return domain.WorktreeCreateResult{}, err
	}

	// The agent's git.worktree.add has no structured result to unmarshal
	// (see doc comment above) — fetch HEAD via the already-relayed, already-
	// whitelisted git.exec (rev-parse is in agent-git-handler.ts's
	// ALLOWED_GIT_SUBCOMMANDS), same follow-up shape as localgit's own
	// CreateWorktree.
	var execResult gitExecResult
	err := r.relay(ctx, repoPath, "git.exec", map[string]any{
		"args": []string{"rev-parse", "HEAD"},
		"cwd":  targetPath,
	}, &execResult)
	if err != nil {
		return domain.WorktreeCreateResult{}, err
	}
	return domain.WorktreeCreateResult{Path: targetPath, HeadSHA: strings.TrimSpace(execResult.Stdout)}, nil
}

// sanitizeBranchForRelayPath mirrors localgit.Executor's own
// sanitizeBranchForPath (unexported in that package, so duplicated here —
// same reasoning as parseForEachRefBranches' own duplicate-rather-than-share
// comment below): replaces '/' (e.g. "feature/foo") so the worktree's
// directory name is filesystem-safe.
func sanitizeBranchForRelayPath(branch string) string {
	return strings.ReplaceAll(branch, "/", "-")
}

// Unstage always relays to "git.bulkUnstage" — same reasoning as Stage
// above.
func (r *RelayExecutor) Unstage(ctx context.Context, repoPath string, paths []string) (domain.SimpleResult, error) {
	var result domain.SimpleResult
	err := r.relay(ctx, repoPath, "git.bulkUnstage", map[string]any{
		"worktreePath": repoPath, "filePaths": paths,
	}, &result)
	return result, err
}

// History: cursor param dropped, ref renamed to baseRef/"baseRef" wire key
// — see TASK-209's Contract correction section.
func (r *RelayExecutor) History(ctx context.Context, repoPath, baseRef string, limit int) ([]domain.CommitRef, error) {
	var result struct {
		Commits []domain.CommitRef `json:"commits"`
	}
	err := r.relay(ctx, repoPath, "git.history", map[string]any{
		"worktreePath": repoPath, "baseRef": baseRef, "limit": limit,
	}, &result)
	return result.Commits, err
}

// CheckIgnored returns only the ignored subset (string[]) per TASK-209's
// Contract correction section — matches the real agent's response shape
// instead of a {path, ignored} pair per input path.
func (r *RelayExecutor) CheckIgnored(ctx context.Context, repoPath string, paths []string) ([]string, error) {
	var result struct {
		Ignored []string `json:"ignoredPaths"`
	}
	err := r.relay(ctx, repoPath, "git.checkIgnored", map[string]any{
		"worktreePath": repoPath, "paths": paths,
	}, &result)
	return result.Ignored, err
}

// ForkSync now sends the required expectedUpstream param — the real agent
// rejects calls without it. See TASK-209's Contract correction section.
func (r *RelayExecutor) ForkSync(ctx context.Context, repoPath, expectedUpstream string) (domain.ForkSyncStatus, error) {
	var result domain.ForkSyncStatus
	err := r.relay(ctx, repoPath, "git.forkSync", map[string]any{
		"worktreePath": repoPath, "expectedUpstream": expectedUpstream,
	}, &result)
	return result, err
}

// UpstreamStatus: still needs TASK-227 (unlike this group's other 3
// shippable-now methods) — no confirmed agent handler is reachable from
// backend-go's transport until then. Param key renamed to worktreePath and
// pushTarget is now the real, structured PushTargetInput (TASK-207's type,
// SOL-032 §0 open question #1 resolved) instead of TASK-209's original
// placeholder string. Wired now; if no agent handler exists at all even
// post-TASK-227, this becomes a FailedPrecondition at runtime (relay()
// returns the agent's "unknown method" error) rather than a compile-time
// gap.
func (r *RelayExecutor) UpstreamStatus(ctx context.Context, repoPath string, pushTarget *domain.PushTargetInput) (domain.UpstreamStatus, error) {
	var result domain.UpstreamStatus
	params := map[string]any{"worktreePath": repoPath}
	if pt := pushTargetParam(pushTarget); pt != nil {
		params["pushTarget"] = pt
	}
	err := r.relay(ctx, repoPath, "git.upstreamStatus", params, &result)
	return result, err
}

// Fetch relays to the real agent's git.fetch
// (specs/agent/api/agent-rpc-catalog-git-fs.md:155): always prunes
// (`git fetch --prune [remote]`), no separate prune flag — needed TASK-227
// (reachability) and PushTargetInput (both now resolved) per TASK-210's own
// Contract correction.
func (r *RelayExecutor) Fetch(ctx context.Context, repoPath string, pushTarget *domain.PushTargetInput) (domain.SimpleResult, error) {
	var result domain.SimpleResult
	params := map[string]any{"worktreePath": repoPath}
	if pt := pushTargetParam(pushTarget); pt != nil {
		params["pushTarget"] = pt
	}
	err := r.relay(ctx, repoPath, "git.fetch", params, &result)
	return result, err
}

// gitChangeEntryWire mirrors parseBranchDiff's {path, status, oldPath?,
// added?, removed?} entry shape on the wire
// (agent/src/relay/git-handler-utils.ts:107-134) — shared by
// CommitCompare/BranchCompare below.
type gitChangeEntryWire struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	OldPath string `json:"oldPath"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
}

func toDomainChangeEntries(entries []gitChangeEntryWire) []domain.GitChangeEntry {
	out := make([]domain.GitChangeEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, domain.GitChangeEntry{
			Path: e.Path, Status: e.Status, OldPath: e.OldPath, Added: e.Added, Removed: e.Removed,
		})
	}
	return out
}

// CommitCompare relays to the real agent's git.commitCompare exactly:
// worktreePath + commitId, response {summary{...}, entries[]} — matches
// commitCompareOp's real shape (agent/src/relay/git-handler-commit-diff-ops.ts:15-122,
// specs/agent/api/agent-rpc-catalog-git-fs.md:50/144), NOT TASK-209's
// original two-arbitrary-commits (baseSha/headSha) design.
func (r *RelayExecutor) CommitCompare(ctx context.Context, repoPath, commitID string) (domain.CommitCompareResult, error) {
	var result struct {
		Summary struct {
			CommitOID    string `json:"commitOid"`
			ParentOID    string `json:"parentOid"`
			CompareRef   string `json:"compareRef"`
			BaseRef      string `json:"baseRef"`
			ChangedFiles int    `json:"changedFiles"`
			Status       string `json:"status"`
			ErrorMessage string `json:"errorMessage"`
		} `json:"summary"`
		Entries []gitChangeEntryWire `json:"entries"`
	}
	err := r.relay(ctx, repoPath, "git.commitCompare", map[string]any{
		"worktreePath": repoPath, "commitId": commitID,
	}, &result)
	if err != nil {
		return domain.CommitCompareResult{}, err
	}
	return domain.CommitCompareResult{
		CommitOID: result.Summary.CommitOID, ParentOID: result.Summary.ParentOID,
		CompareRef: result.Summary.CompareRef, BaseRef: result.Summary.BaseRef,
		ChangedFiles: result.Summary.ChangedFiles, Status: result.Summary.Status,
		ErrorMessage: result.Summary.ErrorMessage, Entries: toDomainChangeEntries(result.Entries),
	}, nil
}

// BranchCompare relays to the real agent's git.branchCompare exactly:
// worktreePath + baseRef, response {summary{...}, entries[]} — matches
// branchCompareOp's real shape (agent/src/relay/git-handler-ops.ts:124-214,
// specs/agent/api/agent-rpc-catalog-git-fs.md:49/143), NOT TASK-209's
// original two-arbitrary-branches (baseBranch/headBranch) design.
func (r *RelayExecutor) BranchCompare(ctx context.Context, repoPath, baseRef string) (domain.BranchCompareResult, error) {
	var result struct {
		Summary struct {
			BaseRef      string `json:"baseRef"`
			BaseOID      string `json:"baseOid"`
			CompareRef   string `json:"compareRef"`
			HeadOID      string `json:"headOid"`
			MergeBase    string `json:"mergeBase"`
			ChangedFiles int    `json:"changedFiles"`
			CommitsAhead int    `json:"commitsAhead"`
			Status       string `json:"status"`
			ErrorMessage string `json:"errorMessage"`
		} `json:"summary"`
		Entries []gitChangeEntryWire `json:"entries"`
	}
	err := r.relay(ctx, repoPath, "git.branchCompare", map[string]any{
		"worktreePath": repoPath, "baseRef": baseRef,
	}, &result)
	if err != nil {
		return domain.BranchCompareResult{}, err
	}
	return domain.BranchCompareResult{
		BaseRef: result.Summary.BaseRef, BaseOID: result.Summary.BaseOID,
		CompareRef: result.Summary.CompareRef, HeadOID: result.Summary.HeadOID,
		MergeBase: result.Summary.MergeBase, ChangedFiles: result.Summary.ChangedFiles,
		CommitsAhead: result.Summary.CommitsAhead, Status: result.Summary.Status,
		ErrorMessage: result.Summary.ErrorMessage, Entries: toDomainChangeEntries(result.Entries),
	}, nil
}

// fileDiffResultWire mirrors buildDiffResult's response shape
// (agent/src/relay/git-diff-result.ts:5-38) — shared by CommitDiff/
// BranchDiff below. Binary content is intentionally not decoded here even
// when the agent sends a base64 preview payload — see
// localgit.buildFileDiffResult's doc comment for why (raw binary can't
// round-trip through this service's proto string fields).
type fileDiffResultWire struct {
	Kind             string `json:"kind"`
	OriginalContent  string `json:"originalContent"`
	ModifiedContent  string `json:"modifiedContent"`
	OriginalIsBinary bool   `json:"originalIsBinary"`
	ModifiedIsBinary bool   `json:"modifiedIsBinary"`
}

func toDomainFileDiff(w fileDiffResultWire) domain.FileDiffResult {
	if w.OriginalIsBinary || w.ModifiedIsBinary {
		return domain.FileDiffResult{Kind: "binary", OriginalIsBinary: w.OriginalIsBinary, ModifiedIsBinary: w.ModifiedIsBinary}
	}
	return domain.FileDiffResult{Kind: w.Kind, OriginalContent: w.OriginalContent, ModifiedContent: w.ModifiedContent}
}

// CommitDiff relays to the real agent's git.commitDiff exactly: worktreePath
// + commitOid + optional parentOid + REQUIRED filePath + optional oldPath,
// response a single diff-result object — matches commitDiffEntry's real
// shape (agent/src/relay/git-handler-commit-diff-ops.ts:124-160,
// specs/agent/api/agent-rpc-catalog-git-fs.md:52/146). Same class of
// per-file fix as GetDiff's own TASK-228 correction — TASK-209's original
// design had no filePath at all and assumed a whole-commit diff.
func (r *RelayExecutor) CommitDiff(ctx context.Context, repoPath, commitOID, parentOID, filePath, oldPath string) (domain.FileDiffResult, error) {
	params := map[string]any{"worktreePath": repoPath, "commitOid": commitOID, "filePath": filePath}
	if parentOID != "" {
		params["parentOid"] = parentOID
	}
	if oldPath != "" {
		params["oldPath"] = oldPath
	}
	var result fileDiffResultWire
	err := r.relay(ctx, repoPath, "git.commitDiff", params, &result)
	if err != nil {
		return domain.FileDiffResult{}, err
	}
	return toDomainFileDiff(result), nil
}

// BranchDiff relays to the real agent's git.branchDiff exactly: worktreePath
// + baseRef + REQUIRED filePath + optional oldPath, response a diff-result
// object — matches branchDiffEntries' real shape
// (agent/src/relay/git-handler-ops.ts:218-288,
// specs/agent/api/agent-rpc-catalog-git-fs.md:51/145). Same per-file fix as
// CommitDiff, plus the same base-ref-only-vs-two-sided fix as BranchCompare.
// includePatch is always sent true — without it the real agent returns
// empty-content placeholder entries (agent-git-handler-ops.ts:259-267),
// which this per-file RPC has no use for.
func (r *RelayExecutor) BranchDiff(ctx context.Context, repoPath, baseRef, filePath, oldPath string) (domain.FileDiffResult, error) {
	params := map[string]any{
		"worktreePath": repoPath, "baseRef": baseRef, "filePath": filePath, "includePatch": true,
	}
	if oldPath != "" {
		params["oldPath"] = oldPath
	}
	var result fileDiffResultWire
	err := r.relay(ctx, repoPath, "git.branchDiff", params, &result)
	if err != nil {
		return domain.FileDiffResult{}, err
	}
	return toDomainFileDiff(result), nil
}

// SubmoduleStatus relays to the real agent's git.submoduleStatus exactly:
// worktreePath + submodulePath + optional area, response a GitStatus-shaped
// object — matches handleGitSubmoduleStatus's real per-submodule shape
// (agent/src/relay/agent-git-handler-extended.ts:196-230,
// specs/agent/api/agent-rpc-catalog-git-fs.md:55/123), NOT TASK-209's
// original "list every submodule" design (SOL-032 §0 open question #3,
// resolved — see GitExecutor.SubmoduleStatus's doc comment for the
// frontend-caller citation that closes this question).
func (r *RelayExecutor) SubmoduleStatus(ctx context.Context, repoPath, submodulePath, area string) (domain.GitStatus, error) {
	params := map[string]any{"worktreePath": repoPath, "submodulePath": submodulePath}
	if area != "" {
		params["area"] = area
	}
	var result domain.GitStatus
	err := r.relay(ctx, repoPath, "git.submoduleStatus", params, &result)
	return result, err
}

func (r *RelayExecutor) RemoteCommitURL(ctx context.Context, repoPath, sha string) (string, error) {
	var result struct {
		URL string `json:"url"`
	}
	err := r.relay(ctx, repoPath, "git.remoteCommitUrl", map[string]any{
		"worktreePath": repoPath, "sha": sha,
	}, &result)
	return result.URL, err
}

func (r *RelayExecutor) RemoteFileURL(ctx context.Context, repoPath, path, ref string) (string, error) {
	var result struct {
		URL string `json:"url"`
	}
	err := r.relay(ctx, repoPath, "git.remoteFileUrl", map[string]any{
		"worktreePath": repoPath, "path": path, "ref": ref,
	}, &result)
	return result.URL, err
}

// RemoteURL relays via the already-whitelisted git.exec ("remote" is an
// ALLOWED_GIT_SUBCOMMANDS entry, git-exec-validator.ts — read-only
// subcommands only, "remote get-url" isn't in REMOTE_WRITE_SUBCOMMANDS) —
// unlike RemoteCommitURL/RemoteFileURL, there is no dedicated
// git.remoteUrl agent RPC (and none is needed: git.exec already covers
// this read).
func (r *RelayExecutor) RemoteURL(ctx context.Context, repoPath, remoteName string) (string, error) {
	if remoteName == "" {
		remoteName = "origin"
	}
	var result gitExecResult
	err := r.relay(ctx, repoPath, "git.exec", map[string]any{
		"args": []string{"remote", "get-url", remoteName},
		"cwd":  repoPath,
	}, &result)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Stdout), nil
}

// Clone and InitRepo have no repoPath/connectionId yet (they create the
// worktree) — destPath doubles as the relay's connectionID, consistent
// with this file's existing "repoPath doubles as connectionId" convention
// (see this file's doc comment's "Known gap").
func (r *RelayExecutor) Clone(ctx context.Context, url, destPath string) (string, string, error) {
	var result struct {
		WorktreePath  string `json:"worktreePath"`
		DefaultBranch string `json:"defaultBranch"`
	}
	err := r.relay(ctx, destPath, "git.clone", map[string]any{
		"url": url, "destPath": destPath,
	}, &result)
	return result.WorktreePath, result.DefaultBranch, err
}

func (r *RelayExecutor) InitRepo(ctx context.Context, destPath, defaultBranch, remoteName, remoteURL string) (string, string, bool, error) {
	var result struct {
		Path          string `json:"path"`
		DefaultBranch string `json:"defaultBranch"`
		RemoteAdded   bool   `json:"remoteAdded"`
	}
	err := r.relay(ctx, destPath, "git.init", map[string]any{
		"destPath": destPath, "defaultBranch": defaultBranch,
		"remoteName": remoteName, "remoteUrl": remoteURL,
	}, &result)
	return result.Path, result.DefaultBranch, result.RemoteAdded, err
}

func (r *RelayExecutor) BaseRefDefault(ctx context.Context, repoPath string) (string, error) {
	var result struct {
		Ref string `json:"ref"`
	}
	err := r.relay(ctx, repoPath, "git.baseRefDefault", map[string]any{"repoPath": repoPath}, &result)
	return result.Ref, err
}

func (r *RelayExecutor) SearchRefs(ctx context.Context, repoPath, query string) ([]string, error) {
	var result struct {
		Refs []string `json:"refs"`
	}
	err := r.relay(ctx, repoPath, "git.searchRefs", map[string]any{"repoPath": repoPath, "query": query}, &result)
	return result.Refs, err
}

func (r *RelayExecutor) CheckHooks(ctx context.Context, repoPath string) ([]string, bool, error) {
	var result struct {
		InstalledHooks   []string `json:"installedHooks"`
		OrcaHooksCurrent bool     `json:"orcaHooksCurrent"`
	}
	err := r.relay(ctx, repoPath, "git.checkHooks", map[string]any{"repoPath": repoPath}, &result)
	return result.InstalledHooks, result.OrcaHooksCurrent, err
}

func (r *RelayExecutor) ReadIssueCommand(ctx context.Context, repoPath string) (string, bool, error) {
	var result struct {
		Content string `json:"content"`
		Exists  bool   `json:"exists"`
	}
	err := r.relay(ctx, repoPath, "git.readIssueCommand", map[string]any{"repoPath": repoPath}, &result)
	return result.Content, result.Exists, err
}

func (r *RelayExecutor) WriteIssueCommand(ctx context.Context, repoPath, content string) error {
	return r.relay(ctx, repoPath, "git.writeIssueCommand", map[string]any{"repoPath": repoPath, "content": content}, nil)
}

func (r *RelayExecutor) ScanSetupScriptImports(ctx context.Context, repoPath string) ([]string, error) {
	var result struct {
		ImportedPaths []string `json:"importedPaths"`
	}
	err := r.relay(ctx, repoPath, "git.scanSetupScriptImports", map[string]any{"repoPath": repoPath}, &result)
	return result.ImportedPaths, err
}

// Method name and param key fixed to match the agent's real
// git.worktree.remove handler (agent-git-handler.ts's handleGitWorktreeRemove
// reads params.path, not params.worktreePath) — same v5.0 dotted-name/
// contract drift as ListWorktreePaths's own fix, see that method's doc
// comment for the full context. CreateWorktree below has the same
// dotted-name mismatch but ALSO needs the new worktree's target path
// computed (the agent's git.worktree.add wants an explicit "path", which
// this call site never derives today) — left as a separate, still-open gap,
// not fixed in this pass.
func (r *RelayExecutor) RemoveWorktree(ctx context.Context, worktreePath string, force bool) error {
	return r.relay(ctx, worktreePath, "git.worktree.remove", map[string]any{
		"path": worktreePath, "force": force,
	}, nil)
}

func (r *RelayExecutor) FetchAndResolveRef(ctx context.Context, repoPath, ref string) (string, error) {
	var result struct {
		SHA string `json:"sha"`
	}
	err := r.relay(ctx, repoPath, "git.fetchRef", map[string]any{
		"repoPath": repoPath, "ref": ref,
	}, &result)
	return result.SHA, err
}

// ListWorktreePaths: the previously-documented "agent has no git.worktreeList
// method at all" gap was stale — agent-rpc-dispatch.ts's v5.0 pass added a
// real handler, just under a dotted method name (git.worktree.list, matching
// its git.worktree.add/git.worktree.remove siblings) and a different
// contract than this call originally assumed: the param is "cwd" (the
// directory `git worktree list` runs from), not "repoPath", and the
// response is {worktrees: [{path, head, branch, ...}]} (agent-git-handler.ts's
// handleGitWorktreeList, backed by the same parseWorktreePorcelain this
// service's own local executor.go uses) — not a bare {paths: string[]}.
// Live-reproduced as WORKTREE_DETECT_FAILED for a genuinely-connected,
// genuinely-reachable dev server once dispatchExecutorForRepo started
// actually routing here (see PollFleetHealth's own commit message for why
// that routing itself was previously dead).
func (r *RelayExecutor) ListWorktreePaths(ctx context.Context, repoPath string) ([]domain.WorktreeGitInfo, error) {
	var result struct {
		Worktrees []struct {
			Path   string `json:"path"`
			Head   string `json:"head"`
			Branch string `json:"branch"`
		} `json:"worktrees"`
	}
	err := r.relay(ctx, repoPath, "git.worktree.list", map[string]any{
		"cwd": repoPath,
	}, &result)
	if err != nil {
		return nil, err
	}
	infos := make([]domain.WorktreeGitInfo, 0, len(result.Worktrees))
	for _, w := range result.Worktrees {
		infos = append(infos, domain.WorktreeGitInfo{Path: w.Path, Head: w.Head, Branch: w.Branch})
	}
	return infos, nil
}

// ForceDeleteBranch implements the REQUIRED (TASK-194) GitExecutor method —
// see domain.ErrForceDeleteBranchUnsupported's doc comment for why the
// operational-fallback sentinel lives in internal/domain rather than here.
func (r *RelayExecutor) ForceDeleteBranch(ctx context.Context, repoPath, branch string) error {
	err := r.relay(ctx, repoPath, "git.forceDeleteBranch", map[string]any{
		"repoPath": repoPath, "branch": branch,
	}, nil)
	if err != nil && isMethodNotFoundError(err) {
		return fmt.Errorf("%w: %v", domain.ErrForceDeleteBranchUnsupported, err)
	}
	return err
}

// ── Group A — branch/ref operations (TASK-207) ─────────────────────────────
//
// Checkout/ListLocalBranches/FastForward/ConflictOperation below were
// redesigned against the real agent contract
// (specs/agent/api/agent-rpc-catalog-git-fs.md) rather than implemented as
// TASK-207's original sketch — see each method's own doc comment for
// citations. RebaseFromBase/AbortRebase/AbortMerge/Discard/BulkDiscard are
// the mechanical param-rename-only subset that sketch got right.

// Checkout relays to the real agent's git.checkout exactly: worktreePath +
// branch only, no create-branch semantics (agent-rpc-catalog-git-fs.md:132,
// agent/src/relay/git-handler.ts:702-719).
func (r *RelayExecutor) Checkout(ctx context.Context, repoPath, branch string) (domain.CheckoutResult, error) {
	var result domain.CheckoutResult
	err := r.relay(ctx, repoPath, "git.checkout", map[string]any{
		"worktreePath": repoPath, "branch": branch,
	}, &result)
	return result, err
}

// gitExecResult mirrors the real agent's git.exec response shape
// (agent-rpc-catalog-git-fs.md:180: "{stdout,stderr}") — used by
// ListLocalBranches below to compose a richer branch listing than the real
// agent's own git.localBranches RPC provides.
type gitExecResult struct {
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

// ListLocalBranches composes a richer per-branch listing (upstream/ahead/
// behind, not just names) than the real agent's own git.localBranches RPC
// returns ({current, branches[]} — names only, agent-rpc-catalog-git-fs.md:133,
// agent/src/relay/git-handler.ts:721-744). It does this via git.exec's
// for-each-ref subcommand instead: confirmed whitelisted with no extra
// restriction on Part B's exec whitelist
// (agent-rpc-catalog-git-fs.md:203-206) — the whitelist RelayExecutor's
// SSH-relay calls actually reach (Part B, not Part A's separate, broader
// git.exec surface). Same --format string as localgit.Executor's
// ListLocalBranches for parser parity between the two implementations.
func (r *RelayExecutor) ListLocalBranches(ctx context.Context, repoPath string) ([]domain.BranchInfo, error) {
	var result gitExecResult
	err := r.relay(ctx, repoPath, "git.exec", map[string]any{
		"args": []string{
			"for-each-ref", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(HEAD)",
			"refs/heads/",
		},
		"cwd": repoPath,
	}, &result)
	if err != nil {
		return nil, err
	}
	return parseForEachRefBranches(result.Stdout), nil
}

// parseForEachRefBranches parses ListLocalBranches' for-each-ref --format
// output — same field layout as localgit.Executor.ListLocalBranches, kept
// as a separate copy in this package (not shared) since the two
// implementations sit in different packages and this parsing is small.
func parseForEachRefBranches(out string) []domain.BranchInfo {
	var branches []domain.BranchInfo
	// Split raw output (not TrimSpace(out)) before trimming each line — see
	// localgit.Executor.ListLocalBranches' identical comment: TrimSpace on
	// the whole blob would eat a legitimate trailing empty %(HEAD) field
	// whenever the alphabetically-last ref isn't the current branch.
	for _, rawLine := range strings.Split(out, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 4 {
			continue
		}
		ahead, behind := parseAheadBehindTrack(fields[2])
		branches = append(branches, domain.BranchInfo{
			Name:      fields[0],
			Upstream:  fields[1],
			Ahead:     ahead,
			Behind:    behind,
			IsCurrent: fields[3] == "*",
		})
	}
	return branches
}

// parseAheadBehindTrack parses %(upstream:track)'s "[ahead N, behind M]"
// (or "[ahead N]" / "[behind M]" / "") format.
func parseAheadBehindTrack(track string) (ahead, behind int) {
	track = strings.Trim(track, "[]")
	for _, part := range strings.Split(track, ",") {
		part = strings.TrimSpace(part)
		var n int
		if _, err := fmt.Sscanf(part, "ahead %d", &n); err == nil {
			ahead = n
		}
		if _, err := fmt.Sscanf(part, "behind %d", &n); err == nil {
			behind = n
		}
	}
	return ahead, behind
}

// pushTargetParam converts an optional domain.PushTargetInput to the wire
// map the real agent's GitPushTarget shape expects
// (agent/src/shared/types.ts:551-557) — nil means omit the field entirely,
// matching resolveRelayPushTarget's undefined-pushTarget branch
// (agent/src/relay/git-handler-push-target.ts:164-166).
func pushTargetParam(pushTarget *domain.PushTargetInput) any {
	if pushTarget == nil {
		return nil
	}
	m := map[string]any{
		"remoteName": pushTarget.RemoteName,
		"branchName": pushTarget.BranchName,
	}
	if pushTarget.RemoteURL != "" {
		m["remoteUrl"] = pushTarget.RemoteURL
	}
	if pushTarget.RemoteCreated {
		m["remoteCreated"] = pushTarget.RemoteCreated
	}
	return m
}

// FastForward relays to the real agent's git.fastForward
// (`pullWithArgs(['--ff-only'])`, agent-rpc-catalog-git-fs.md:160,
// agent/src/relay/git-handler.ts:1190-1192), which takes the same optional
// structured pushTarget as push/pull/fetch (SOL-032 §0 open question #1) —
// not TASK-207's original plain branch-string sketch. pushTarget == nil
// omits the field so the agent resolves the worktree's configured push
// target itself.
func (r *RelayExecutor) FastForward(ctx context.Context, repoPath string, pushTarget *domain.PushTargetInput) (domain.FastForwardResult, error) {
	var result domain.FastForwardResult
	params := map[string]any{"worktreePath": repoPath}
	if pt := pushTargetParam(pushTarget); pt != nil {
		params["pushTarget"] = pt
	}
	err := r.relay(ctx, repoPath, "git.fastForward", params, &result)
	return result, err
}

func (r *RelayExecutor) RebaseFromBase(ctx context.Context, repoPath, baseRef string) (domain.RebaseResult, error) {
	var result domain.RebaseResult
	err := r.relay(ctx, repoPath, "git.rebaseFromBase", map[string]any{
		"worktreePath": repoPath, "baseRef": baseRef,
	}, &result)
	return result, err
}

func (r *RelayExecutor) AbortRebase(ctx context.Context, repoPath string) (domain.SimpleResult, error) {
	var result domain.SimpleResult
	err := r.relay(ctx, repoPath, "git.abortRebase", map[string]any{"worktreePath": repoPath}, &result)
	return result, err
}

func (r *RelayExecutor) AbortMerge(ctx context.Context, repoPath string) (domain.SimpleResult, error) {
	var result domain.SimpleResult
	err := r.relay(ctx, repoPath, "git.abortMerge", map[string]any{"worktreePath": repoPath}, &result)
	return result, err
}

// ConflictOperation relays to the real agent's git.conflictOperation
// exactly: worktreePath only, response is the bare operation string
// ("merge"/"rebase"/"cherry-pick"/"unknown" —
// agent-rpc-catalog-git-fs.md:136, agent/src/relay/git-handler.ts:886-889).
// See ResolveConflict below for the per-file resolve op TASK-207's
// original sketch conflated with this one.
func (r *RelayExecutor) ConflictOperation(ctx context.Context, repoPath string) (string, error) {
	var result string
	err := r.relay(ctx, repoPath, "git.conflictOperation", map[string]any{"worktreePath": repoPath}, &result)
	return result, err
}

// ResolveConflict has no real agent RPC to relay to: Part B's git.exec
// whitelist — the whitelist this relay-connected (SSH) path actually
// reaches — explicitly excludes both `checkout` and `add`
// (agent-rpc-catalog-git-fs.md:203-227's "Not allowed at all" list), so
// there is no whitelisted way to compose ours/theirs/markResolved
// remotely. Returns domain.ErrConflictResolveUnsupportedOverRelay directly
// (no RPC round-trip attempted — this is a known, static limitation, not a
// runtime failure to probe for) — same operational-fallback shape as
// ForceDeleteBranch's domain.ErrForceDeleteBranchUnsupported. Only
// localgit.Executor.ResolveConflict does real work.
func (r *RelayExecutor) ResolveConflict(ctx context.Context, repoPath, path, operation string) (domain.SimpleResult, error) {
	return domain.SimpleResult{}, domain.ErrConflictResolveUnsupportedOverRelay
}

func (r *RelayExecutor) Discard(ctx context.Context, repoPath, filePath string) (domain.SimpleResult, error) {
	var result domain.SimpleResult
	err := r.relay(ctx, repoPath, "git.discard", map[string]any{
		"worktreePath": repoPath, "filePath": filePath,
	}, &result)
	return result, err
}

func (r *RelayExecutor) BulkDiscard(ctx context.Context, repoPath string, filePaths []string) (domain.BulkDiscardResult, error) {
	var result domain.BulkDiscardResult
	err := r.relay(ctx, repoPath, "git.bulkDiscard", map[string]any{
		"worktreePath": repoPath, "filePaths": filePaths,
	}, &result)
	return result, err
}

// isMethodNotFoundError is a placeholder heuristic for detecting an
// agent's "unknown method" response through the Relay RPC's error path —
// FLAGGED: confirm the real error shape RelayResponse/infra-fleet-service's
// Relay RPC surfaces for an unsupported agent method before finalizing;
// this may need to check a gRPC status code (codes.Unimplemented) rather
// than string-matching, depending on how infra-fleet-service's Relay
// usecase translates an agent-side JSON-RPC "method not found" today.
func isMethodNotFoundError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "method not found") || strings.Contains(msg, "unknown method")
}

// Complete implements usecase.AICompleter by relaying to the Dev Server
// Agent's ai.complete method, per specs/agent/api/agent-rpc-catalog-runtime.md's
// confirmed real handler (`ai-complete-handler.ts:47`): params
// `prompt(required), format?, taskId?, model?, accountId?, resolvedApiKey?`,
// result `{content, model?}`. Only `prompt` is sent here — model/account
// resolution is deliberately out of this service's scope
// (git-gateway-service.md §3.1's context-assembler framing), so the agent
// falls back to its own configured default model.
//
// Unlike the git.* methods above, connectionID here is the caller's actual
// ResolvedConnection.ConnectionID, not a repoPath standing in for it —
// ai.complete has no filesystem-path argument, so there's no equivalent of
// those methods' repoPath/connectionID conflation to inherit.
func (r *RelayExecutor) Complete(ctx context.Context, connectionID, prompt string) (string, error) {
	var result struct {
		Content string `json:"content"`
	}
	err := r.relay(ctx, connectionID, "ai.complete", map[string]any{
		"prompt": prompt,
	}, &result)
	return result.Content, err
}

// ── usecase.FilesystemExecutor ──────────────────────────────────────────
//
// Relays to the Dev Server Agent's fs.* methods. Field names below are
// named to match this service's own domain types; reconcile against the
// real handler contract (specs/agent/api/agent-rpc-catalog-git-fs.md)
// before removing this comment, same caveat as the git.* methods above.
// RelayExecutor deliberately does NOT implement
// usecase.LocalOnlyFilesystemExecutor (Rename/Copy) — the agent's fs.*
// surface has no rename/copy method (BUG-009) — nor ReadFileChunk, which
// is unsupported for any relay target by design (TASK-052 checks
// conn.Connected before ever reaching this executor).

func (r *RelayExecutor) ReadFile(ctx context.Context, repoPath, relPath string) ([]byte, error) {
	var result struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := r.relay(ctx, repoPath, "fs.readFile", map[string]any{
		"path": filepath.Join(repoPath, relPath),
	}, &result); err != nil {
		return nil, err
	}
	return decodeFileContent(result.Content, result.Encoding)
}

func (r *RelayExecutor) ReadFilePreview(ctx context.Context, repoPath, relPath string, maxBytes int64) ([]byte, bool, error) {
	var result struct {
		Content   string `json:"content"`
		Encoding  string `json:"encoding"`
		Truncated bool   `json:"truncated"`
	}
	if err := r.relay(ctx, repoPath, "fs.readFile", map[string]any{
		"path":     filepath.Join(repoPath, relPath),
		"maxBytes": maxBytes,
	}, &result); err != nil {
		return nil, false, err
	}
	content, err := decodeFileContent(result.Content, result.Encoding)
	return content, result.Truncated, err
}

func (r *RelayExecutor) ReadDir(ctx context.Context, repoPath, relPath string) ([]domain.DirEntry, error) {
	var result struct {
		Entries []domain.DirEntry `json:"entries"`
	}
	err := r.relay(ctx, repoPath, "fs.readDir", map[string]any{
		"path": filepath.Join(repoPath, relPath),
	}, &result)
	return result.Entries, err
}

func (r *RelayExecutor) WriteFile(ctx context.Context, repoPath, relPath string, content []byte, createParents bool) (int64, error) {
	var result struct {
		BytesWritten int64 `json:"bytesWritten"`
	}
	err := r.relay(ctx, repoPath, "fs.writeFile", map[string]any{
		"path":          filepath.Join(repoPath, relPath),
		"content":       base64.StdEncoding.EncodeToString(content),
		"encoding":      "base64",
		"createParents": createParents,
	}, &result)
	if err != nil {
		return 0, err
	}
	if result.BytesWritten == 0 {
		result.BytesWritten = int64(len(content))
	}
	return result.BytesWritten, nil
}

func (r *RelayExecutor) WriteFileChunk(ctx context.Context, repoPath, relPath string, offsetBytes int64, content []byte, isFinal bool) (int64, error) {
	var result struct {
		BytesWritten int64 `json:"bytesWritten"`
	}
	err := r.relay(ctx, repoPath, "fs.writeFile", map[string]any{
		"path":        filepath.Join(repoPath, relPath),
		"offsetBytes": offsetBytes,
		"content":     base64.StdEncoding.EncodeToString(content),
		"encoding":    "base64",
		"isFinal":     isFinal,
	}, &result)
	if err != nil {
		return 0, err
	}
	if result.BytesWritten == 0 {
		result.BytesWritten = int64(len(content))
	}
	return result.BytesWritten, nil
}

func (r *RelayExecutor) CreateDir(ctx context.Context, repoPath, relPath string, recursive, noClobber bool) error {
	return r.relay(ctx, repoPath, "fs.mkdir", map[string]any{
		"path":      filepath.Join(repoPath, relPath),
		"recursive": recursive,
		"noClobber": noClobber,
	}, nil)
}

// CreateFile has no dedicated Dev Server Agent method — the agent's
// fs.writeFile (agent/src/relay/fs-agent-extensions.ts's handleFsWriteFile)
// always overwrites, with no exclusive/no-clobber flag. Stat-then-write is
// best-effort (a TOCTOU race remains, same class of gap the agent's own
// fs.mkdir already accepts by silently ignoring CreateDir's noClobber
// param) rather than a hard blocker, since the common "New File" case
// isn't a concurrent-writer race.
func (r *RelayExecutor) CreateFile(ctx context.Context, repoPath, relPath string) error {
	stat, err := r.Stat(ctx, repoPath, relPath)
	if err != nil {
		return err
	}
	if stat.Exists {
		return fmt.Errorf("relay: %s already exists", relPath)
	}
	return r.relay(ctx, repoPath, "fs.writeFile", map[string]any{
		"path":          filepath.Join(repoPath, relPath),
		"content":       "",
		"encoding":      "utf-8",
		"createParents": true,
	}, nil)
}

func (r *RelayExecutor) Delete(ctx context.Context, repoPath, relPath string, recursive bool) error {
	return r.relay(ctx, repoPath, "fs.rmdir", map[string]any{
		"path":      filepath.Join(repoPath, relPath),
		"recursive": recursive,
	}, nil)
}

func (r *RelayExecutor) Stat(ctx context.Context, repoPath, relPath string) (domain.FileStat, error) {
	var result domain.FileStat
	err := r.relay(ctx, repoPath, "fs.stat", map[string]any{
		"path": filepath.Join(repoPath, relPath),
	}, &result)
	return result, err
}

func (r *RelayExecutor) Search(ctx context.Context, repoPath string, opts domain.SearchOptions) ([]domain.SearchMatch, error) {
	var result struct {
		Matches []domain.SearchMatch `json:"matches"`
	}
	err := r.relay(ctx, repoPath, "fs.grep", map[string]any{
		"repoPath":   repoPath,
		"pattern":    opts.Pattern,
		"isRegex":    opts.IsRegex,
		"pathGlob":   opts.PathGlob,
		"maxResults": opts.MaxResults,
	}, &result)
	return result.Matches, err
}

func (r *RelayExecutor) Glob(ctx context.Context, repoPath, pattern string, maxResults int) ([]string, error) {
	var result struct {
		Paths []string `json:"paths"`
	}
	err := r.relay(ctx, repoPath, "fs.glob", map[string]any{
		"repoPath":   repoPath,
		"pattern":    pattern,
		"maxResults": maxResults,
	}, &result)
	return result.Paths, err
}

// StreamFileChanges implements usecase.FileWatchStreamer (BACKLOG-003) by
// opening infra-fleet-service's StreamFileChanges RPC — the one relay()
// call site in this file that ISN'T a Relay/RelayByDevServer unary passthrough,
// since fs.changed is a push stream relay()'s request/response shape can't
// carry (see infrafleetv1.InfraFleetService's StreamFileChanges doc
// comment). Owns its own cancelable ctx, independent of the caller's —
// unsubscribe MUST be called exactly once (mirrors every Stream* method in
// devserveragent/client.go one layer down).
func (r *RelayExecutor) StreamFileChanges(ctx context.Context, connectionID, path string) (<-chan usecase.FileChangeEvent, func(), error) {
	streamCtx, cancel := context.WithCancel(ctx)
	stream, err := r.client.StreamFileChanges(streamCtx, &infrafleetv1.StreamFileChangesRequest{
		ConnectionId: connectionID,
		Path:         path,
	})
	if err != nil {
		cancel()
		return nil, nil, fmt.Errorf("grpcclient: opening StreamFileChanges for path %q: %w", path, err)
	}

	out := make(chan usecase.FileChangeEvent, 64)
	go func() {
		defer close(out)
		for {
			ev, err := stream.Recv()
			if err != nil {
				return // stream ended — io.EOF on clean close (ctx canceled), or a real transport error
			}
			select {
			case out <- usecase.FileChangeEvent{
				Kind: ev.GetKind(), Path: ev.GetAbsolutePath(),
				OldPath: ev.GetOldAbsolutePath(), IsDirectory: ev.GetIsDirectory(),
			}:
			case <-streamCtx.Done():
				return
			}
		}
	}()

	unsubscribe := func() { cancel() }
	return out, unsubscribe, nil
}

// decodeFileContent turns the agent's {content, encoding} pair into raw
// bytes, matching WriteFile/WriteFileChunk's own base64-on-the-wire
// convention above.
func decodeFileContent(content, encoding string) ([]byte, error) {
	if encoding == "base64" {
		return base64.StdEncoding.DecodeString(content)
	}
	return []byte(content), nil
}
