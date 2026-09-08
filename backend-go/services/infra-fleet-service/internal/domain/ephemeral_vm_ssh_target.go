package domain

// EphemeralVmSshTargetRecord is the persisted row in
// infra.ephemeral_vm_ssh_targets — TASK-BE-EVM-014's Vault-path pointer
// registry for Hướng A ("agent-outbound"), keyed by the ephemeral VM
// runtime it belongs to. Deliberately distinct from SshTarget (see
// ssh_target.go's doc comment): SshTarget is user-registered and points to
// a Vault SSH secrets engine ROLE (cert-issuance, never raw material);
// this record is recipe-provisioned and points to a Vault KV v2 PATH
// holding the actual (never-in-Postgres) identity material — see
// BE-SOL-EVM-004 §2's "Quyết định đã chốt" mục 2.
type EphemeralVmSshTargetRecord struct {
	ID       string
	TenantID string
	// RuntimeID is the owning ephemeral_vm_runtimes.id — one record per
	// runtime (idx_ephemeral_vm_ssh_targets_runtime).
	RuntimeID string
	Host      string
	Port      int32
	Username  string
	// IdentityFileVaultPath/IdentityAgentVaultPath point into Vault's KV v2
	// engine (secret/data/infra-fleet/ephemeral-vm-ssh-targets/<runtime_id>
	// by convention — see AgentOutboundSshVaultKVPath) — NEVER raw key
	// material. Exactly one is expected to be non-empty per recipe target,
	// mirroring identityFile/identityAgent's independent optionality in
	// EphemeralVmRecipeSshTargetSchema.
	IdentityFileVaultPath  string
	IdentityAgentVaultPath string
}

// EphemeralVmSshTarget carries the recipe-provisioned SSH connection recipe
// for an ephemeral VM's `ssh`-type vm.provision result (BE-SOL-EVM-004 §5b,
// TASK-BE-EVM-012/013, Hướng B) — deliberately distinct from BOTH SshTarget
// (see that type's doc comment: PERSISTED-row invariant "never store raw
// key material, only a Vault SSH role") AND from
// EphemeralVmSshTargetRecord just above (TASK-BE-EVM-014's Hướng A
// registry, itself only a Vault PATH pointer, never raw material either).
// EphemeralVmSshTarget is the one of these three that actually carries
// resolved credential material — and it never becomes a Postgres row: it
// lives only in RAM for the duration of one
// usecase.EphemeralVmSshProvisioner.Provision call (recipe-provisioned,
// discarded after use).
//
// Field values come from usecase.EphemeralVmRecipeSshTarget (itself
// normalized from ephemeral-vm-recipes.ts's
// EphemeralVmRecipeSshTargetSchema) — see
// usecase.EphemeralVmRelay.buildEphemeralVmSshTarget for the conversion.
// PrivateKeyPEM/IdentityAgentSocket are the two credential channels: at
// most one is meaningfully populated, matching
// EphemeralVmRecipeSshTarget's identityFile/identityAgent being mutually
// optional on the wire. Real Vault resolution of the recipe's `identityFile`
// pointer into actual PEM bytes (BE-SOL-EVM-004 §5c / §"Quyết định đã chốt"
// mục 2) is NOT implemented by TASK-BE-EVM-012/013 — no Vault adapter file
// was in either task's scope — so PrivateKeyPEM is populated verbatim from
// the recipe's identityFile field today. This is a known, documented gap
// for a follow-up task before Hướng B is production-ready with real Vault
// SSH secrets engine material; it does not block exercising the rest of the
// dial/deploy/launch/register pipeline.
type EphemeralVmSshTarget struct {
	Host     string
	Port     int
	Username string
	// PrivateKeyPEM is PEM-encoded private key material, resolved and held
	// only in memory — never logged, never persisted. See package-level doc
	// comment above for the current, unresolved-from-Vault gap.
	PrivateKeyPEM string
	// IdentityAgentSocket is a local ssh-agent UNIX socket path — an
	// alternative to PrivateKeyPEM, never routed through Vault.
	IdentityAgentSocket string
	// JumpHost is an optional "[user@]host[:port]" ProxyJump-style hop —
	// authenticated with the same credential as the final target (the
	// recipe does not carry separate jump-host credentials).
	JumpHost string
	// ProxyCommand is an optional shell command whose stdin/stdout become
	// the transport pipe for the SSH handshake (OpenSSH ProxyCommand
	// semantics) — mutually exclusive with JumpHost in practice, though
	// this type does not enforce that (the recipe schema doesn't either).
	ProxyCommand string
}
