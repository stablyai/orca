// Package domain holds workflow-service's entities, value objects, and the
// StepExecutor strategy interface. Per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md this
// package has zero imports outside stdlib + other domain/ packages — no
// database, no gRPC, no framework, and (deliberately, see StepExecutor's
// doc comment) no infra-fleet-service relay client either.
package domain

import "context"

// StepType is the discriminator for a workflow step's kind — mirrors
// workflowv1.StepType (proto) one-for-one, see
// specs/backend-go/services/workflow-service.md §4.
type StepType string

const (
	StepTypeUnspecified  StepType = ""
	StepTypeAgent        StepType = "agent"
	StepTypeShell        StepType = "shell"
	StepTypeNotification StepType = "notification"
	StepTypeWebhook      StepType = "webhook"
	StepTypeCondition    StepType = "condition"
	// StepTypeCommitPush — CR-AUTO-003/TASK-BE-AUTO-005. Not part of the
	// original five (see this const block's original comment) — added so
	// automation-service's ExecuteAutomationChain (CR-AUTO-002) has a
	// dedicated step type for the commit_push action, rather than reusing
	// StepTypeShell to shell out raw git commands (which AGENTS.md's "Git
	// Binary Compatibility" section rules out — needs
	// GitCapabilityCache-style version handling, not a bare `git commit`
	// string).
	StepTypeCommitPush StepType = "commit_push"
)

// Valid reports whether t is one of the known step types.
func (t StepType) Valid() bool {
	switch t {
	case StepTypeAgent, StepTypeShell, StepTypeNotification, StepTypeWebhook, StepTypeCondition, StepTypeCommitPush:
		return true
	default:
		return false
	}
}

// ResultStatus is a StepResult's outcome — "completed" and "failed" only;
// no in-progress/partial state, since a StepExecutor call is synchronous
// from this service's point of view (§3.1: ExecuteAdHocStep is
// synchronous, and a real Execute's wave dispatch awaits each step before
// gating the next wave).
type ResultStatus string

const (
	ResultStatusCompleted ResultStatus = "completed"
	ResultStatusFailed    ResultStatus = "failed"
)

// StepResult is the outcome of running one step through a StepExecutor —
// mirrors workflowv1.StepResult (proto) one-for-one.
type StepResult struct {
	Status     ResultStatus
	OutputJSON string
}

// AgentStepConfig is the Agent step type's config shape — the prompt-driven
// agent invocation internal/adapter/infrafleetclient.AgentExecutor relays to
// infra-fleet-service's Relay RPC (workflow-service.md §4).
//
// ConnectionID is a new field added in this pass: nothing in this scaffold
// previously identified *which* infra-fleet-service connection (dev server +
// worktree binding) an agent/shell/notification step should target — an
// undocumented gap this build closes, naming the field to match
// infra-fleet-service's own ConnectionID/connectionId convention (see its
// internal/usecase/resolve_connection.go and relay.go).
type AgentStepConfig struct {
	ConnectionID string `json:"connectionId"`
	Prompt       string `json:"prompt"`
	WorktreePath string `json:"worktreePath,omitempty"`
	TrustPreset  string `json:"trustPreset,omitempty"`
}

// ShellStepConfig is the Shell step type's config shape — a script relayed
// to infra-fleet-service's Relay RPC for execution on the target connection.
// ConnectionID: see AgentStepConfig's doc comment (same new-field rationale).
type ShellStepConfig struct {
	ConnectionID string            `json:"connectionId"`
	Script       string            `json:"script"`
	Env          map[string]string `json:"env,omitempty"`
}

// NotificationStepConfig is the Notification step type's config shape — a
// message relayed to infra-fleet-service's Relay RPC for dispatch.
// ConnectionID: see AgentStepConfig's doc comment (same new-field rationale).
type NotificationStepConfig struct {
	ConnectionID string `json:"connectionId"`
	Channel      string `json:"channel"`
	Message      string `json:"message"`
}

// CommitPushStepConfig is the CommitPush step type's config shape —
// CR-AUTO-003/TASK-BE-AUTO-005. ConnectionID: see AgentStepConfig's doc
// comment (same new-field rationale) — relays to agent's git.commit then
// (if Push) git.push on the same connection.
type CommitPushStepConfig struct {
	ConnectionID string `json:"connectionId"`
	Message      string `json:"message"`
	// Push defaults to true when the config_json key is absent — see
	// GitCommitPushExecutor.Execute's doc comment for why this can't be a
	// bare `bool` (Go's zero value for bool is false, which would silently
	// invert the "push by default" convention CR-AUTO-003 specifies).
	Push *bool `json:"push,omitempty"`
}

// StepExecutor is the domain-level strategy interface each step type
// implements — one Execute per StepType, dispatched by
// usecase.StepExecutorRegistry.Resolve.
//
// Deviation note: specs/backend-go/services/workflow-service.md §4 places
// this interface in usecase/, per
// architecture/03-clean-architecture-guidelines.md's general "interface
// lives with its consumer" rule. It's defined here instead, per this
// service's explicit build instructions: the strategy itself (dispatch by
// StepType to a pure Execute(ctx, config) -> (StepResult, error) contract)
// is a pure domain concept independent of any adapter, even though four of
// five concrete implementations happen to need I/O. The port that *resolves*
// a StepType to a StepExecutor (usecase.StepExecutorRegistry) still lives in
// usecase/, matching the general rule for the one piece that's genuinely
// usecase-shaped.
type StepExecutor interface {
	Execute(ctx context.Context, stepConfigJSON string) (StepResult, error)
}
