package usecase

import (
	"context"
	"errors"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// EphemeralVmRelay implements ephemeralVm.attachWorkspace/suspendWorkspace/
// resumeWorkspace/cleanup (SOL-004 Group 2a). Same "no backend-host
// fallback, connectionId required" rule as EmulatorRelay — running a
// repo-authored shell command on the shared backend-go host is the same
// class of blast-radius problem browser/emulator driving already excludes.
//
// Correction against real desktop source (SOL-004's own sketch had
// AttachWorkspace exec the recipe's create command — the real
// attachEphemeralVmWorkspace, desktop/src/main/ipc/ephemeral-vm-runtime-
// handlers.ts:69-77, is pure bookkeeping with no shell exec at all; the
// real create-command exec happens in ephemeralVm.provision, out of scope
// for this bug set). AttachWorkspace here is Postgres-only — no agent
// relay. SuspendWorkspace/ResumeWorkspace/CleanupWorkspace genuinely relay
// the recipe's suspend/resume/destroy command (already resolved by the
// caller, api-gateway's wscompat layer — see TASK-005) via a new
// agent-side vm.exec method that does not exist today.
type EphemeralVmRelay struct {
	resolver ConnectionResolver
	agent    DevServerAgentClient
	runtimes EphemeralVmRuntimeRepository
	// sshProvisioner is nil unless WithSshProvisioner was passed to
	// NewEphemeralVmRelay — an unconfigured provisioner preserves the
	// original "ssh-type is recorded as an error" behavior (see
	// applyProvisionResult), the same fail-safe-when-unwired convention
	// devserveragent.Client.sshProvisioner already uses for relay-ssh mode.
	sshProvisioner EphemeralVmSshProvisioner
}

// EphemeralVmRelayOption configures optional EphemeralVmRelay behavior
// beyond its 3 required collaborators — mirrors
// devserveragent.Option/WithRelaySSH's established pattern in this same
// codebase, chosen here (over widening NewEphemeralVmRelay's fixed
// argument list) specifically to avoid churning every one of this file's
// existing ~23 NewEphemeralVmRelay(resolver, agent, runtimes) test call
// sites (TASK-BE-EVM-012).
type EphemeralVmRelayOption func(*EphemeralVmRelay)

// WithSshProvisioner wires the EphemeralVmSshProvisioner implementation
// selected by config.EphemeralVmSshMode (TASK-BE-EVM-012/013) — see
// applyProvisionResult's "ssh" branch for how it's used.
func WithSshProvisioner(p EphemeralVmSshProvisioner) EphemeralVmRelayOption {
	return func(uc *EphemeralVmRelay) { uc.sshProvisioner = p }
}

func NewEphemeralVmRelay(resolver ConnectionResolver, agent DevServerAgentClient, runtimes EphemeralVmRuntimeRepository, opts ...EphemeralVmRelayOption) *EphemeralVmRelay {
	uc := &EphemeralVmRelay{resolver: resolver, agent: agent, runtimes: runtimes}
	for _, opt := range opts {
		opt(uc)
	}
	return uc
}

// resolveDevServerAndRepoPath resolves both the DevServer to relay to and
// the RepoPath the recipe command must run against from one
// ResolveConnection call — this service must not gain a dependency on
// git-gateway-service (the existing dependency direction is the other way).
func (uc *EphemeralVmRelay) resolveDevServerAndRepoPath(ctx context.Context, tenantID, connectionID string) (domain.DevServer, string, error) {
	if connectionID == "" {
		return domain.DevServer{}, "", apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_NO_CONNECTION", "ephemeral vm lifecycle operations require an active dev server connection — there is no local/backend-host fallback", nil)
	}
	connected, devServer, conn, err := uc.resolver.ResolveConnection(ctx, tenantID, connectionID)
	if err != nil {
		return domain.DevServer{}, "", apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve connection", err)
	}
	if !connected {
		return domain.DevServer{}, "", apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_NO_CONNECTION", "no dev server is bound to this connection", nil)
	}
	return devServer, conn.RepoPath, nil
}

// callAgent mirrors EmulatorRelay.callAgent exactly — real agent "method
// not found" -> typed, permanent FailedPrecondition.
func (uc *EphemeralVmRelay) callAgent(ctx context.Context, devServer domain.DevServer, method string, params map[string]any) (map[string]any, error) {
	result, err := uc.agent.Exec(ctx, devServer, method, params)
	if err != nil {
		if errors.Is(err, domain.ErrAgentMethodNotFound) {
			return nil, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_UNSUPPORTED",
				"this dev server's agent build does not support ephemeral vm commands ("+method+") — see specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md", err)
		}
		return nil, apperrors.New(apperrors.KindInternal, "INFRA_AGENT_EXEC_FAILED", "failed to relay "+method+" to dev server agent", err)
	}
	return result, nil
}

// AttachWorkspace is pure bookkeeping — see this file's doc comment for why
// this differs from SOL-004's original create-command-exec sketch.
func (uc *EphemeralVmRelay) AttachWorkspace(ctx context.Context, runtimeID, workspaceID string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "active", workspaceID, "")
}

// SuspendWorkspace relays command (the recipe's `suspend` field, resolved
// by the caller — see TASK-005) via vm.exec, then persists the transition.
func (uc *EphemeralVmRelay) SuspendWorkspace(ctx context.Context, connectionID, workspaceID, command string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	runtime, err := uc.runtimes.GetByWorkspaceID(ctx, tenantID, workspaceID)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindNotFound, "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND", "no runtime is attached to this workspace", err)
	}
	if command == "" {
		return uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "suspended", "", "")
	}
	devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
	if err != nil {
		return domain.EphemeralVmRuntime{}, err
	}
	_, err = uc.callAgent(ctx, devServer, "vm.exec", map[string]any{
		"repoPath": repoPath, "command": command, "phase": "suspend",
		"recipeId": runtime.RecipeID, "runtimeId": runtime.ID,
	})
	if err != nil {
		_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "error", "", err.Error())
		return domain.EphemeralVmRuntime{}, err
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "suspended", "", "")
}

// ResumeWorkspace mirrors SuspendWorkspace exactly, target status "active".
func (uc *EphemeralVmRelay) ResumeWorkspace(ctx context.Context, connectionID, workspaceID, command string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	runtime, err := uc.runtimes.GetByWorkspaceID(ctx, tenantID, workspaceID)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindNotFound, "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND", "no runtime is attached to this workspace", err)
	}
	if command != "" {
		devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
		if err != nil {
			return domain.EphemeralVmRuntime{}, err
		}
		if _, err := uc.callAgent(ctx, devServer, "vm.exec", map[string]any{
			"repoPath": repoPath, "command": command, "phase": "resume",
			"recipeId": runtime.RecipeID, "runtimeId": runtime.ID,
		}); err != nil {
			_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "error", "", err.Error())
			return domain.EphemeralVmRuntime{}, err
		}
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "active", "", "")
}

// CleanupWorkspace runs the recipe's destroy command (if any — command=""
// means the recipe has no destroy step or destroyDisabled is set, mirroring
// desktop's own "cleanupDisabled" short-circuit) then marks the runtime
// destroyed regardless of whether a command ran, matching desktop's
// cleanupEphemeralVmWorkspace always progressing the record to a terminal
// state even when there's nothing to execute.
//
// Open design note carried from TASK-004's spec: unlike Suspend/Resume
// (looked up by workspaceID), Cleanup takes runtimeID directly and never
// resolves a connectionID from it internally — the caller (TASK-005's
// wscompat handler) must supply connectionID explicitly (empty when the
// runtime was never attached to a workspace, in which case command is also
// expected to be "" and no agent call is attempted).
func (uc *EphemeralVmRelay) CleanupWorkspace(ctx context.Context, connectionID, runtimeID, command string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	if command != "" {
		runtime, err := uc.runtimes.Get(ctx, tenantID, runtimeID)
		if err != nil {
			return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindNotFound, "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND", "runtime not found", err)
		}
		devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
		if err != nil {
			return domain.EphemeralVmRuntime{}, err
		}
		if _, err := uc.callAgent(ctx, devServer, "vm.exec", map[string]any{
			"repoPath": repoPath, "command": command, "phase": "destroy",
			"recipeId": runtime.RecipeID, "runtimeId": runtime.ID,
		}); err != nil {
			_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "error", "", err.Error())
			return domain.EphemeralVmRuntime{}, err
		}
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "destroyed", "", "")
}

// Provision resolves connectionID and relays vm.provision to the agent
// (TASK-BE-EVM-003's StreamVmProvision), forwarding every event to the
// caller while reacting to the terminal one by persisting the runtime's
// outcome. The connectionId->repoPath resolution happens BEFORE the agent
// is ever called — resolveDevServerAndRepoPath's existing
// INFRA_EPHEMERAL_VM_NO_CONNECTION error (same "no backend-host fallback"
// rule as Suspend/Resume/Cleanup) short-circuits with no agent call at all.
//
// The "ssh" branch dials out via applyProvisionResult's sshProvisioner
// dispatch (TASK-BE-EVM-012/013) IF one was wired via WithSshProvisioner —
// otherwise (uc.sshProvisioner == nil) an "ssh" result is still recorded as
// an error, preserving the original CR-EVM-005 guard for a deployment that
// hasn't configured either Hướng A or Hướng B yet.
func (uc *EphemeralVmRelay) Provision(ctx context.Context, connectionID, recipeID, runtimeID, command string) (<-chan VmProvisionEvent, func(), error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, nil, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
	if err != nil {
		return nil, nil, err
	}

	events, unsubscribe, err := uc.agent.StreamVmProvision(ctx, devServer, VmProvisionParams{
		RepoPath: repoPath, Command: command, RecipeID: recipeID, RuntimeID: runtimeID,
	})
	if err != nil {
		if errors.Is(err, domain.ErrAgentMethodNotFound) {
			return nil, nil, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_UNSUPPORTED",
				"this dev server's agent build does not support ephemeral vm provisioning (vm.provision) — see specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md", err)
		}
		return nil, nil, apperrors.New(apperrors.KindInternal, "INFRA_AGENT_EXEC_FAILED", "failed to relay vm.provision to dev server agent", err)
	}

	out := make(chan VmProvisionEvent, 64)
	go func() {
		defer close(out)
		for event := range events {
			switch event.Type {
			case "result":
				uc.applyProvisionResult(ctx, tenantID, runtimeID, devServer, event.Result)
			case "error":
				_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "error", "", event.ErrorMsg)
			}
			out <- event
		}
	}()

	return out, unsubscribe, nil
}

// applyProvisionResult persists Provision's terminal "result" event —
// "orca-server" transitions to "provisioning" (a real pairing/environment_id
// still has to land, see TASK-BE-EVM-006); "ssh" dispatches through
// uc.sshProvisioner (TASK-BE-EVM-012/013 — see below); anything else
// unrecognized is recorded as an error.
//
// Real-source correction against TASK-BE-EVM-012's own sketch: that task's
// doc pointed at AttachWorkspace as the guard site to remove
// (`connection_type == "ssh"` check). The real guard was never there —
// AttachWorkspace is (and stays) pure bookkeeping with no connection-type
// branch at all (see this file's top doc comment); the actual "ssh is
// blocked" guard lived here, in this switch's "ssh" case, reached from
// Provision's terminal-event handling, not from a later AttachWorkspace
// call. Dispatching here (rather than deferring to AttachWorkspace) also
// means this usecase does not need a new domain.EphemeralVmRuntime field to
// persist the recipe's SshTarget across requests, as TASK-BE-EVM-012's
// sketch anticipated might be needed (BE-SOL-EVM-004 §5c: "backend-go tự
// set environment_id ngay lập tức... không có độ trễ/sự kiện async tách
// biệt nào" — the whole point is there IS no gap between receiving the ssh
// result and dialing it).
func (uc *EphemeralVmRelay) applyProvisionResult(ctx context.Context, tenantID, runtimeID string, devServer domain.DevServer, result VmProvisionResult) {
	switch result.Type {
	case "orca-server":
		_, _ = uc.runtimes.UpdateProvisionResult(ctx, tenantID, runtimeID, "provisioning", "orca-server", "")
	case "ssh":
		uc.applySshProvisionResult(ctx, tenantID, runtimeID, devServer, result)
	default:
		_, _ = uc.runtimes.UpdateProvisionResult(ctx, tenantID, runtimeID, "error", result.Type,
			"unrecognized vm.provision result type: "+result.Type)
	}
}

// applySshProvisionResult dispatches an "ssh"-type vm.provision result
// through the configured EphemeralVmSshProvisioner (Hướng A or Hướng B,
// selected by config.EphemeralVmSshMode at wiring time) — the CR-EVM-005
// guard this backend originally shipped (README's "Không tự ý mở khoá guard
// connection_type == 'ssh'" rule) stays in force ONLY as the fallback when
// no provisioner was wired (uc.sshProvisioner == nil), e.g. a deployment
// that hasn't set EPHEMERAL_VM_SSH_MODE's target implementation up yet.
//
// devServer (TASK-BE-EVM-016, BE-SOL-EVM-004 §6b) is the SAME Dev Server
// this whole Provision call already resolved via resolveDevServerAndRepoPath
// — threaded through here (and into EphemeralVmSshProvisioner.Provision's
// new sourceDevServer parameter) rather than re-resolved.
func (uc *EphemeralVmRelay) applySshProvisionResult(ctx context.Context, tenantID, runtimeID string, devServer domain.DevServer, result VmProvisionResult) {
	if uc.sshProvisioner == nil {
		_, _ = uc.runtimes.UpdateProvisionResult(ctx, tenantID, runtimeID, "error", "ssh",
			"ssh-type ephemeral VM recipes require an EphemeralVmSshProvisioner to be configured — see TASK-BE-EVM-012/013")
		return
	}
	target := buildEphemeralVmSshTarget(result.SshTarget, result.ProjectRoot)
	if _, err := uc.sshProvisioner.Provision(ctx, tenantID, runtimeID, devServer, target); err != nil {
		_, _ = uc.runtimes.UpdateProvisionResult(ctx, tenantID, runtimeID, "error", "ssh", err.Error())
		return
	}
	// "provisioning", not "active" — mirrors the orca-server branch above:
	// AttachWorkspace (pure bookkeeping) is still the step that transitions
	// to "active" once the user actually opens the workspace, regardless of
	// which connection_type got them there.
	_, _ = uc.runtimes.UpdateProvisionResult(ctx, tenantID, runtimeID, "provisioning", "ssh", "")
}

// buildEphemeralVmSshTarget converts the wire-normalized recipe result
// (EphemeralVmRecipeSshTarget, adapter/devserveragent's
// normalizeVmProvisionResult) into domain.EphemeralVmSshTarget, the type
// EphemeralVmSshProvisioner.Provision actually takes.
//
// GAP 1 FIX (TASK-BE-EVM-016, BE-SOL-EVM-004 §6a): sshTarget.IdentityFile is
// a raw filesystem PATH (see domain.EphemeralVmSshTarget's doc comment) —
// this now maps to IdentityFilePath, NOT PrivateKeyPEM (the old mapping
// treated the path string as if it were already-resolved PEM content,
// which TASK-BE-EVM-012/013's own doc comments flagged as an open gap).
// PrivateKeyPEM is populated later, only by Hướng B, after
// DevServerAgentClient.ReadCredentialFile resolves IdentityFilePath's bytes
// (TASK-BE-EVM-017) — never here.
//
// projectRoot (TASK-BE-EVM-016, §6b) is VmProvisionResult.ProjectRoot,
// passed separately (not part of EphemeralVmRecipeSshTarget's own wire
// shape) so EphemeralVmSshProvisioner.Provision can register a real
// infra.connections row.
//
// sshTarget is never nil when called from applySshProvisionResult
// (VmProvisionResult.Type == "ssh" is only set alongside a non-nil
// SshTarget, see normalizeVmProvisionResult), but a nil guard keeps this
// safe to call standalone (e.g. from tests) too.
func buildEphemeralVmSshTarget(sshTarget *EphemeralVmRecipeSshTarget, projectRoot string) domain.EphemeralVmSshTarget {
	if sshTarget == nil {
		return domain.EphemeralVmSshTarget{ProjectRoot: projectRoot}
	}
	return domain.EphemeralVmSshTarget{
		Host:                sshTarget.Host,
		Port:                int(sshTarget.Port),
		Username:            sshTarget.Username,
		ProjectRoot:         projectRoot,
		IdentityFilePath:    sshTarget.IdentityFile,
		IdentityAgentSocket: sshTarget.IdentityAgent,
		JumpHost:            sshTarget.JumpHost,
		ProxyCommand:        sshTarget.ProxyCommand,
	}
}

// CancelProvision relays vm.cancelProvision to the agent, telling it to
// abort runtimeID's in-flight `create` process (the agent's
// provisionAbortRegistry, agent-ephemeral-vm-handler.ts's
// handleVmCancelProvision) — a DIFFERENT concern from the
// provisionId->unsubscribe registry that stops THIS PROCESS's own channel
// demux (Provision's returned unsubscribe func), which lives at the
// wscompat layer (TASK-BE-EVM-005), not here.
func (uc *EphemeralVmRelay) CancelProvision(ctx context.Context, connectionID, runtimeID string) error {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	devServer, _, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
	if err != nil {
		return err
	}
	_, err = uc.callAgent(ctx, devServer, "vm.cancelProvision", map[string]any{"runtimeId": runtimeID})
	return err
}
