// Package usecase holds task-service's application services and the ports
// they need — defined here, implemented in internal/adapter/*, per the
// Dependency Inversion convention in
// specs/backend-go/architecture/03-clean-architecture-guidelines.md.
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/services/task-service/internal/domain"
)

// TaskRepository is the persistence port for tasks. Implemented by
// internal/adapter/postgres against task-service's own database — see
// specs/backend-go/architecture/05-data-architecture.md's
// database-per-service rule.
type TaskRepository interface {
	Create(ctx context.Context, task domain.Task) (domain.Task, error)
	Get(ctx context.Context, tenantID, id string) (domain.Task, error)
	// GetAncestors returns the chain from the given task up to its root,
	// walking tasks.parent_id (task-service.md §6's WITH RECURSIVE note).
	// The first element is the task itself; the last is the root. maxDepth
	// bounds the walk (task-service.md §8's max-depth guard) — 0 means the
	// repository's own default cap.
	GetAncestors(ctx context.Context, tenantID, id string, maxDepth int) ([]domain.Task, error)
	// UpdateStatus persists a task's status transition. Currently only ever
	// called to set StatusInProgress on dispatch (see ExecuteTask) — there is
	// no RPC surface yet to transition a task back out of in_progress. See
	// this service's README "Known gaps".
	UpdateStatus(ctx context.Context, tenantID, id, status string) error
	// HasActiveExecutions reports whether tenantID/projectID has any task
	// currently in_progress — see usecase.HasActiveExecutions's doc comment
	// for the one-way-transition caveat this answer is subject to today.
	HasActiveExecutions(ctx context.Context, tenantID, projectID string) (bool, error)
	// List returns tasks for tenantID, optionally filtered by projectID
	// (empty = no filter), cursor-paginated by page_size/page_token.
	List(ctx context.Context, tenantID, projectID, pageToken string, pageSize int32) ([]domain.Task, string, error)
	// Update persists a partial field update (title/status). Status
	// transitions into StatusInProgress are rejected at the domain layer
	// (domain.Task.SetStatus) before this is ever called — see TASK-223's
	// Context note.
	Update(ctx context.Context, tenantID string, task domain.Task) error
	// Delete removes a task. task_edges/task_grants reference tasks(id)
	// with ON DELETE CASCADE (migrations/0001_init.up.sql) — no explicit
	// edge/grant cleanup needed.
	Delete(ctx context.Context, tenantID, id string) error
}

// EdgeRepository is the persistence port for task_edges rows. Cycle
// detection is NOT this port's job — the AddEdge usecase calls
// domain.DetectCycle itself, using edges this port fetched, per Clean
// Architecture's dependency rule (domain logic never lives in an adapter).
type EdgeRepository interface {
	// Add persists a single edge. Callers (the AddEdge usecase) are
	// responsible for running cycle detection before calling this for a
	// depends_on edge — see task-service.md §8's "Edge-mutation
	// consistency" note and this service's README for the known gap this
	// scaffold has around doing the check-then-write atomically.
	Add(ctx context.Context, tenantID string, edge domain.TaskEdge) error
	// ListByKind returns every edge of the given kind for the tenant — the
	// graph AddEdge's cycle check walks. Fetching the whole kind-scoped
	// edge set (rather than only the reachable subgraph) keeps this port's
	// contract simple; see this service's README for the scale follow-up.
	ListByKind(ctx context.Context, tenantID string, kind domain.EdgeKind) ([]domain.TaskEdge, error)
	// ListFrom returns the edges of the given kind originating at
	// fromTaskID — used by the Execute usecase's complexity branch (§3.1)
	// and reused as-is by GetDependencies (TASK-223) for the identical
	// depends_on edge kind.
	ListFrom(ctx context.Context, tenantID, fromTaskID string, kind domain.EdgeKind) ([]domain.TaskEdge, error)
}

// GrantRepository is the persistence port for task_grants rows.
type GrantRepository interface {
	Grant(ctx context.Context, tenantID string, grant domain.Grant) error
	// ListGrantsForAncestors returns every grant recorded against any of
	// taskIDs, grouped by task ID — the input ResolveGrant's BFS walk
	// (domain/grant_resolution.go) consumes.
	ListGrantsForAncestors(ctx context.Context, tenantID string, taskIDs []string) (map[string][]domain.Grant, error)
}

// TeamScopeResolver resolves a user's team memberships by calling
// tenant-service — task-service never reads tenant-service's team_members
// table directly, per task-service.md §2/§9's bounded-context rule.
//
// STUB in this scaffold: internal/adapter/grpcclient's implementation
// always returns an empty team list rather than actually calling
// tenant-service. Team-scoped grants will silently never match until this
// is wired to a real tenant-service client — see this service's README.
type TeamScopeResolver interface {
	ResolveTeams(ctx context.Context, tenantID, userID string) ([]string, error)
}

// OPAClient is the authorization port ResolvePermission uses for the
// "does this resolved level authorize this action" decision (§9's
// domain-computes/OPA-decides split) — implemented by
// internal/adapter/opaclient against the shared embedded OPA evaluator
// (common/policy), consuming
// backend-go/policy/orca-authz/task_grant.rego's
// data.orca.authz.task.allow rule.
type OPAClient interface {
	// Decision reports whether level authorizes action for tenantID, per
	// task_grant.rego's level_actions table. Never called with
	// domain.GrantLevelUnspecified — ResolvePermission.Execute returns its
	// own PermissionDenied before reaching this call when domain.ResolveGrant
	// finds no match.
	Decision(ctx context.Context, level domain.GrantLevel, action, tenantID string) (bool, error)
}

// SimpleExecutor relays Execute's simple-path dispatch to
// infra-fleet-service (-> Dev Server Agent agent.execPrompt), per
// task-service.md §3.1.
//
// internal/adapter/grpcclient's implementation is real (TASK-224): resolves
// the task's project_id to a connectionId + worktreePath via
// ProjectExecutionResolver and relays through infra-fleet-service's Relay
// RPC, method "agent.execPrompt" (not "agent.exec" — see that file's doc
// comment for the full agent-rpc-catalog citation trail behind that
// choice).
type SimpleExecutor interface {
	Execute(ctx context.Context, tenantID, taskID, requestID, prompt string) (executionRef string, err error)
}

// ComplexExecutor relays Execute's complex-path dispatch to
// orchestration-service's coordinator, per task-service.md §3.1.
//
// STUB in this scaffold: internal/adapter/grpcclient's implementation
// returns a fixed placeholder execution ref without calling
// orchestration-service — see this service's README.
type ComplexExecutor interface {
	Execute(ctx context.Context, tenantID, taskID, requestID, prompt string) (executionRef string, err error)
}

// ProjectExecutionResolver resolves a project's execution target
// (connectionId, or none for host-local) via infra-fleet-service —
// task-service never calls project-service or infra-fleet-service directly
// from this port's consumers (SimpleExecutor, AIDecompose); the resolution
// itself lives in internal/adapter/grpcclient, mirroring
// git-gateway-service's ConnectionResolver split.
//
// worktreePath is infra-fleet-service's ResolveConnectionResponse.repo_path
// echoed straight through — the same field git-gateway-service's
// ConnectionResolver folds into ResolvedConnection.RepoPath
// (git-gateway-service/internal/usecase/ports.go:26-37) for its GitExecutor
// to operate against. SimpleExecutor (TASK-224 Gap 1) needs this same value
// as agent.execPrompt's required worktreePath field — see
// simple_executor.go's doc comment for the full citation trail.
type ProjectExecutionResolver interface {
	ResolveConnection(ctx context.Context, tenantID, projectID string) (connectionID, worktreePath string, connected bool, err error)
}

// AIProviderContextResolver resolves AI provider/account context for a
// tenant+user by calling ai-provider-service — distinct from
// ProjectExecutionResolver (execution target) and from AICompleter below
// (the actual completion call).
type AIProviderContextResolver interface {
	ResolveContext(ctx context.Context, tenantID, userID string) (providerContext string, err error)
}

// AICompleter relays a prompt to the Dev Server Agent's ai.complete method
// over a resolved connectionID — same port shape as
// git-gateway-service.AICompleter, implemented here against
// infra-fleet-service's Relay RPC rather than duplicated per-service.
type AICompleter interface {
	Complete(ctx context.Context, connectionID, prompt string) (string, error)
}

// TxRunner wraps a set of subtask creates + parent-link edges in one
// Postgres transaction — closes TASK-224 Gap 2 (AIApply's create-subtask +
// add-edge loop was not atomic: a mid-loop failure could leave a partial
// subtree). A real precedent for this shape now exists in this repo (it did
// not when ai_apply.go was first written) —
// credential-broker-service/internal/usecase/ports.go's TxRunner
// (RunInTx(ctx, fn func(ctx, metadataRepo, auditRepo) error) error),
// implemented via pgx.BeginFunc in that service's postgres.Repository. This
// port mirrors that shape exactly: RunInTx hands fn a TaskRepository/
// EdgeRepository pair already scoped to the open transaction, reusing the
// exact port shapes AIApply's CreateTask/AddEdge sub-usecases already know,
// rather than inventing transaction-specific interfaces or a generic
// UnitOfWork abstraction. If fn returns a non-nil error, every write fn made
// through either repo rolls back together. Implemented by
// internal/adapter/postgres.Repository.
type TxRunner interface {
	RunInTx(ctx context.Context, fn func(ctx context.Context, tasks TaskRepository, edges EdgeRepository) error) error
}
