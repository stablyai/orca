package domain

// EphemeralVmSshTargetRecord is the persisted row in
// infra.ephemeral_vm_ssh_targets — TASK-BE-EVM-014's audit registry for
// Hướng A ("agent-outbound"), keyed by the ephemeral VM runtime it belongs
// to. Deliberately distinct from SshTarget (see ssh_target.go's doc
// comment): SshTarget is user-registered and points to a Vault SSH secrets
// engine ROLE (cert-issuance, never raw material); this record is
// recipe-provisioned.
//
// GAP 1 FIX (BE-SOL-EVM-004 §6a, TASK-BE-EVM-016): field names below
// predate the discovery that identityFile/identityAgent were never Vault
// pointers (TASK-BE-EVM-014's original "Vault KV v2 path" premise was
// wrong — see EphemeralVmSshTarget's doc comment). The migration/columns
// are NOT renamed here (out of this task's scope — no test or caller
// depends on the Go-level name) — these two fields now hold the raw
// identityFile PATH / identityAgent socket PATH actually dialed, kept for
// audit/debugging parity with the original schema, still NEVER raw key
// material.
type EphemeralVmSshTargetRecord struct {
	ID       string
	TenantID string
	// RuntimeID is the owning ephemeral_vm_runtimes.id — one record per
	// runtime (idx_ephemeral_vm_ssh_targets_runtime).
	RuntimeID string
	Host      string
	Port      int32
	Username  string
	// IdentityFileVaultPath/IdentityAgentVaultPath — see this type's doc
	// comment above for the post-Gap-1-fix meaning (no longer Vault
	// pointers). Exactly one is expected to be non-empty per recipe target,
	// mirroring identityFile/identityAgent's independent optionality in
	// EphemeralVmRecipeSshTargetSchema.
	IdentityFileVaultPath  string
	IdentityAgentVaultPath string
	// HostKeyFingerprint (TASK-BE-EVM-019, BE-SOL-EVM-004 §6d,
	// migrations/0016) is the SHA256 host-key fingerprint
	// (ssh.FingerprintSHA256 format) observed on this runtime's most recent
	// successful dial — Hướng B's TOFU (trust-on-first-use) baseline,
	// written by adapter/backendrelaysshprovisioner.Provisioner after
	// adapter/ephemeralsshconn.Connector.Connect succeeds. Empty means "no
	// dial has ever succeeded for this runtime" (accept-and-record on the
	// next dial) — Hướng A (AgentOutboundSshProvisioner) never sets this
	// column; its own host-key verification lives agent-side
	// (TASK-AG-EVM-010).
	HostKeyFingerprint string
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
//
// GAP 1 FIX (BE-SOL-EVM-004 §6a, TASK-BE-EVM-016/017): the recipe's
// `identityFile` is, across the WHOLE codebase (desktop's
// system-ssh-args.ts, SshTargetForm.tsx), always a filesystem PATH — never
// Vault secret content — and that path already lives on the SAME Dev
// Server Agent that ran the recipe's `create` command. There is nothing to
// resolve from Vault for it. IdentityFilePath below carries that raw path;
// PrivateKeyPEM carries actual PEM bytes ONLY once something has read the
// file — Hướng A (agent-outbound) never populates PrivateKeyPEM at all (the
// agent reads IdentityFilePath itself, locally); Hướng B
// (backend-relay-deploy) populates it by calling
// DevServerAgentClient.ReadCredentialFile against the SOURCE dev server
// before dialing (TASK-BE-EVM-017).
type EphemeralVmSshTarget struct {
	Host     string
	Port     int
	Username string
	// ProjectRoot is VmProvisionResult.ProjectRoot, threaded through so
	// EphemeralVmSshProvisioner.Provision can register a REAL
	// infra.connections row (BE-SOL-EVM-004 §6b, TASK-BE-EVM-016) instead of
	// returning a conventional connectionID that does not resolve.
	ProjectRoot string
	// IdentityFilePath is the recipe's raw identityFile PATH, forwarded
	// verbatim (never treated as a Vault pointer — see this type's doc
	// comment above). Mutually optional with IdentityAgentSocket, matching
	// EphemeralVmRecipeSshTarget's identityFile/identityAgent on the wire.
	IdentityFilePath string
	// PrivateKeyPEM is PEM-encoded private key material, resolved and held
	// only in memory — never logged, never persisted. Populated ONLY by
	// Hướng B, after DevServerAgentClient.ReadCredentialFile returns
	// IdentityFilePath's bytes (see this type's doc comment above).
	PrivateKeyPEM string
	// IdentityAgentSocket is a local ssh-agent UNIX socket path — an
	// alternative to IdentityFilePath/PrivateKeyPEM, never routed through
	// Vault, never read/copied by either Hướng (only the socket path
	// itself travels).
	IdentityAgentSocket string
	// KnownHostKeyFingerprint (TASK-BE-EVM-016's Hướng A TOFU completion —
	// BE-SOL-EVM-004 §6d) is the SHA256 host-key fingerprint recorded from a
	// prior successful dial for this runtimeID, if any (empty on first
	// dial). Mirrors backendrelaysshprovisioner's knownFingerprint for
	// Hướng B — AgentOutboundSshProvisioner.Provision reads it from
	// EphemeralVmSshTargetRepository before dialing and forwards it to the
	// agent via DialHiddenSshTarget so the agent's own TOFU check
	// (ssh-outbound-client.ts, TASK-AG-EVM-010) can verify instead of
	// blindly accepting every dial as "first use".
	KnownHostKeyFingerprint string
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
