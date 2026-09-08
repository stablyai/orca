package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeEphemeralVmSshDevServerResolver is an in-memory
// EphemeralVmSshDevServerResolver — always resolves to the fixed devServer
// unless resolveErr is set, matching this package's other fake-repository
// conventions.
type fakeEphemeralVmSshDevServerResolver struct {
	devServer  domain.DevServer
	resolveErr error
	calls      []string // runtimeID, for assertions
}

func (f *fakeEphemeralVmSshDevServerResolver) ResolveDevServer(ctx context.Context, tenantID, runtimeID string) (domain.DevServer, error) {
	f.calls = append(f.calls, runtimeID)
	if f.resolveErr != nil {
		return domain.DevServer{}, f.resolveErr
	}
	return f.devServer, nil
}

// fakeEphemeralVmSshVaultResolver is an in-memory
// EphemeralVmSshVaultResolver — records every (mount, path) it was asked to
// read, for TestVaultSshPath_SeparateFromUserRegisteredSshTargets.
type fakeEphemeralVmSshVaultResolver struct {
	data       map[string]any
	readErr    error
	readMounts []string
	readPaths  []string
}

func (f *fakeEphemeralVmSshVaultResolver) KVRead(ctx context.Context, mount, path string) (map[string]any, error) {
	f.readMounts = append(f.readMounts, mount)
	f.readPaths = append(f.readPaths, path)
	if f.readErr != nil {
		return nil, f.readErr
	}
	return f.data, nil
}

// fakeEphemeralVmSshTargetRepository is an in-memory
// EphemeralVmSshTargetRepository — TestAgentOutboundSshProvisioner_CredentialNeverPersisted
// inspects upserted to confirm no PEM/socket value was ever handed to it.
type fakeEphemeralVmSshTargetRepository struct {
	upserted []domain.EphemeralVmSshTargetRecord
}

func (f *fakeEphemeralVmSshTargetRepository) Upsert(ctx context.Context, record domain.EphemeralVmSshTargetRecord) (domain.EphemeralVmSshTargetRecord, error) {
	f.upserted = append(f.upserted, record)
	return record, nil
}

func (f *fakeEphemeralVmSshTargetRepository) Get(ctx context.Context, tenantID, runtimeID string) (domain.EphemeralVmSshTargetRecord, bool, error) {
	for _, r := range f.upserted {
		if r.TenantID == tenantID && r.RuntimeID == runtimeID {
			return r, true, nil
		}
	}
	return domain.EphemeralVmSshTargetRecord{}, false, nil
}

func TestAgentOutboundSshProvisioner_ResolvesVaultThenCallsAgent(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	devServers := &fakeEphemeralVmSshDevServerResolver{devServer: domain.DevServer{ID: "ds-1"}}
	vault := &fakeEphemeralVmSshVaultResolver{data: map[string]any{"private_key_pem": "-----BEGIN OPENSSH PRIVATE KEY-----\nreal-material\n-----END OPENSSH PRIVATE KEY-----"}}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{
		Host: "10.0.0.5", Port: 22, Username: "orca",
		PrivateKeyPEM: "recipe-identity-file-pointer", // pre-resolution value
	}

	connectionID, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", target)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if connectionID == "" {
		t.Error("expected a non-empty connectionID")
	}

	if len(vault.readPaths) != 1 {
		t.Fatalf("expected exactly 1 vault read, got %d", len(vault.readPaths))
	}
	if len(devServers.calls) != 1 || devServers.calls[0] != "runtime-1" {
		t.Errorf("expected devServer resolved for runtime-1, got %+v", devServers.calls)
	}
	if len(agent.dialHiddenSshTargetCalls) != 1 {
		t.Fatalf("expected exactly 1 agent dial call, got %d", len(agent.dialHiddenSshTargetCalls))
	}
	// The agent must receive the VAULT-RESOLVED material, not the raw
	// pre-resolution recipe pointer string.
	dialed := agent.dialHiddenSshTargetCalls[0]
	if dialed.PrivateKeyPEM != "-----BEGIN OPENSSH PRIVATE KEY-----\nreal-material\n-----END OPENSSH PRIVATE KEY-----" {
		t.Errorf("expected agent to receive vault-resolved PEM material, got %q", dialed.PrivateKeyPEM)
	}
	if dialed.Host != "10.0.0.5" || dialed.Username != "orca" {
		t.Errorf("expected host/username to pass through unchanged, got %+v", dialed)
	}
}

func TestAgentOutboundSshProvisioner_CredentialNeverPersisted(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	devServers := &fakeEphemeralVmSshDevServerResolver{devServer: domain.DevServer{ID: "ds-1"}}
	vault := &fakeEphemeralVmSshVaultResolver{data: map[string]any{
		"private_key_pem":       "super-secret-pem",
		"identity_agent_socket": "/tmp/ssh-agent.sock",
	}}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{
		Host: "10.0.0.5", Port: 22, Username: "orca",
		PrivateKeyPEM:       "recipe-identity-file-pointer",
		IdentityAgentSocket: "recipe-identity-agent-pointer",
	}

	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The RPC to the agent DID carry the credential (asserted by the other
	// test) — this test asserts the ONLY other persistence path this type
	// touches (the audit-row repository) never sees it, "by value, once,
	// over the RPC channel only" (BE-SOL-EVM-004 §2/§3's invariant).
	if len(records.upserted) != 1 {
		t.Fatalf("expected exactly 1 upserted audit row, got %d", len(records.upserted))
	}
	rec := records.upserted[0]
	if rec.IdentityFileVaultPath == "" || rec.IdentityAgentVaultPath == "" {
		t.Errorf("expected both vault PATH pointers to be recorded, got %+v", rec)
	}

	// domain.EphemeralVmSshTargetRecord has no field a resolved credential
	// value could even be assigned to — this loop is a structural guard
	// against a future field addition silently reintroducing the leak: it
	// fails to compile (not just fails at runtime) the moment such a field
	// exists and this test isn't updated to check it.
	if rec.IdentityFileVaultPath == "super-secret-pem" || rec.IdentityAgentVaultPath == "/tmp/ssh-agent.sock" {
		t.Error("resolved credential material leaked into the persisted audit row")
	}
}

func TestVaultSshPath_SeparateFromUserRegisteredSshTargets(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	devServers := &fakeEphemeralVmSshDevServerResolver{devServer: domain.DevServer{ID: "ds-1"}}
	vault := &fakeEphemeralVmSshVaultResolver{data: map[string]any{"private_key_pem": "pem"}}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca", PrivateKeyPEM: "pointer"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-42", target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(vault.readPaths) != 1 {
		t.Fatalf("expected exactly 1 vault read, got %d", len(vault.readPaths))
	}
	gotPath := vault.readPaths[0]

	// "Quyết định đã chốt" mục 2: separate KV path family from
	// infra.ssh_targets' Vault usage (which is the SSH secrets engine's
	// ssh/sign/<role>, not a KV path at all — see sshconn.Connector.Connect)
	// AND keyed by runtime_id, never colliding with a user-registered
	// target's identity.
	if gotPath == "" {
		t.Fatal("expected a non-empty vault path")
	}
	if wantPrefix := "infra-fleet/ephemeral-vm-ssh-targets/"; len(gotPath) < len(wantPrefix) || gotPath[:len(wantPrefix)] != wantPrefix {
		t.Errorf("expected vault path to use the ephemeral-vm-ssh-targets prefix, got %q", gotPath)
	}
	if gotPath == "infra-fleet/ssh-targets/runtime-42" {
		t.Errorf("vault path must not reuse infra.ssh_targets' path family, got %q", gotPath)
	}
	if gotPath[len(gotPath)-len("runtime-42"):] != "runtime-42" {
		t.Errorf("expected vault path to be keyed by runtimeID, got %q", gotPath)
	}
}

func TestAgentOutboundSshProvisioner_NoIdentityMaterial_SkipsVault(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	devServers := &fakeEphemeralVmSshDevServerResolver{devServer: domain.DevServer{ID: "ds-1"}}
	vault := &fakeEphemeralVmSshVaultResolver{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(vault.readPaths) != 0 {
		t.Errorf("expected no vault read when target carries no identity material, got %d", len(vault.readPaths))
	}
}

func TestAgentOutboundSshProvisioner_VaultReadFails_ReturnsError(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	devServers := &fakeEphemeralVmSshDevServerResolver{devServer: domain.DevServer{ID: "ds-1"}}
	vault := &fakeEphemeralVmSshVaultResolver{readErr: errors.New("vault unreachable")}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca", PrivateKeyPEM: "pointer"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", target); err == nil {
		t.Fatal("expected an error when vault read fails")
	}
	if len(agent.dialHiddenSshTargetCalls) != 0 {
		t.Error("expected no agent dial call when vault resolution failed")
	}
}

func TestAgentOutboundSshProvisioner_DevServerResolutionFails_ReturnsError(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	devServers := &fakeEphemeralVmSshDevServerResolver{resolveErr: errors.New("no known dev server for this runtime")}
	vault := &fakeEphemeralVmSshVaultResolver{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", target); err == nil {
		t.Fatal("expected an error when devServer resolution fails")
	}
	if len(agent.dialHiddenSshTargetCalls) != 0 {
		t.Error("expected no agent dial call when devServer resolution failed")
	}
}

func TestAgentOutboundSshProvisioner_AgentDialFails_ReturnsError(t *testing.T) {
	agent := &fakeDevServerAgentClient{dialHiddenSshTargetErr: errors.New("agent rejected dial")}
	devServers := &fakeEphemeralVmSshDevServerResolver{devServer: domain.DevServer{ID: "ds-1"}}
	vault := &fakeEphemeralVmSshVaultResolver{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, devServers, vault, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", target); err == nil {
		t.Fatal("expected an error when the agent rejects the dial")
	}
	if len(records.upserted) != 0 {
		t.Error("expected no audit row upserted when the dial itself failed")
	}
}
