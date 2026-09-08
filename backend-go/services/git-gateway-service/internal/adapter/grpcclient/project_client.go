// project_client.go implements usecase.ProjectClient against
// project-service's gRPC surface. RecordWorktreeCreated/RecordWorktreeRemoved
// need no project-service proto change — those RPCs already exist
// (proto/orca/project/v1/project.proto). GetRepo is this task's own
// addition on top of that surface — see its doc comment below for the
// confirmed gap.
package grpcclient

import (
	"context"

	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"

	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

type ProjectClient struct {
	client projectv1.ProjectServiceClient
}

func NewProjectClient(client projectv1.ProjectServiceClient) *ProjectClient {
	return &ProjectClient{client: client}
}

// GetRepo backs project.proto's ProjectService.GetRepo RPC (added to close
// the confirmed gap this doc comment previously described: project.proto
// had no single-repo-by-id lookup, only ListRepos(project_id)/AddRepo/
// ReorderRepos/RemoveRepo, none of which answer "does this repo exist /
// what project is it under" for an arbitrary repo id). Every caller
// (CreateWorktree, DetectWorktrees, PrefetchCreateBase, ResolvePrBase,
// ResolveMrBase) still maps a not-found/unreachable result to
// WORKTREE_REPO_NOT_FOUND itself; this adapter just forwards the real
// answer (or a real error) instead of an always-failing stub.
func (p *ProjectClient) GetRepo(ctx context.Context, repoID string) (domain.RepoInfo, error) {
	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return domain.RepoInfo{}, err
	}
	resp, err := p.client.GetRepo(ctx, &projectv1.GetRepoRequest{RepoId: repoID})
	if err != nil {
		return domain.RepoInfo{}, err
	}
	r := resp.GetRepo()
	return domain.RepoInfo{
		ID:          r.GetId(),
		ProjectID:   r.GetProjectId(),
		URL:         r.GetUrl(),
		DisplayName: r.GetDisplayName(),
		DevServerID: resp.GetDevServerId(),
		// HiddenTargetID (TASK-BE-EVM-018, BE-SOL-EVM-004 §6c — closes
		// TASK-BE-EVM-015's gap #2 at the wire level): project-service's
		// GetRepo does not populate a real value yet (see
		// project.proto's GetRepoResponse.hidden_target_id doc comment for
		// the still-open architectural join), so this is always "" today —
		// but the mapping itself is real, not a stub, ready the moment
		// project-service starts populating it.
		HiddenTargetID: resp.GetHiddenTargetId(),
	}, nil
}

func (p *ProjectClient) RecordWorktreeCreated(ctx context.Context, projectID, repoID, path, branch string, lineage domain.WorktreeLineageCapture) (domain.WorktreeRecord, error) {
	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return domain.WorktreeRecord{}, err
	}
	req := &projectv1.RecordWorktreeCreatedRequest{
		ProjectId: projectID, RepoId: repoID, Path: path, Branch: branch,
	}
	// Optional string proto fields want a *string, not "" — nonEmptyPtr
	// keeps every unsupplied lineage field genuinely unset on the wire
	// rather than an empty-but-present string.
	req.ParentWorktreeId = nonEmptyPtr(lineage.ParentWorktreeID)
	req.Origin = nonEmptyPtr(lineage.Origin)
	req.CaptureSource = nonEmptyPtr(lineage.CaptureSource)
	req.TaskId = nonEmptyPtr(lineage.TaskID)
	req.OrchestrationRunId = nonEmptyPtr(lineage.OrchestrationRunID)
	req.CoordinatorHandle = nonEmptyPtr(lineage.CoordinatorHandle)
	req.CreatedByTerminalHandle = nonEmptyPtr(lineage.CreatedByTerminalHandle)

	resp, err := p.client.RecordWorktreeCreated(ctx, req)
	if err != nil {
		return domain.WorktreeRecord{}, err
	}
	wt := resp.GetWorktree()
	return domain.WorktreeRecord{ID: wt.GetId(), Path: wt.GetPath(), Branch: wt.GetBranch()}, nil
}

// nonEmptyPtr returns nil for an empty string, else a pointer to it —
// distinguishes "not supplied" from a genuinely empty value for every
// optional lineage field on RecordWorktreeCreatedRequest.
func nonEmptyPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (p *ProjectClient) RecordWorktreeRemoved(ctx context.Context, worktreeID string) error {
	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return err
	}
	_, err = p.client.RecordWorktreeRemoved(ctx, &projectv1.RecordWorktreeRemovedRequest{WorktreeId: worktreeID})
	return err
}
