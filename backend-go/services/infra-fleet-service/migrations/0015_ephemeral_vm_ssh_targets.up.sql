-- TASK-BE-EVM-014 (Hướng A) — records what host/credential-pointer was
-- actually used to dial a "ssh"-type ephemeral VM runtime's hidden target,
-- keyed by runtime_id. Deliberately NOT infra.ssh_targets (different
-- lifecycle/owner — recipe-provisioned vs. user-registered, see
-- BE-SOL-EVM-004 §2) and deliberately stores only VAULT PATHS for identity
-- material, never raw key content (Postgres never sees PrivateKeyPEM — see
-- usecase.AgentOutboundSshProvisioner's doc comment).
CREATE TABLE infra.ephemeral_vm_ssh_targets (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL,
  runtime_id                UUID NOT NULL REFERENCES infra.ephemeral_vm_runtimes(id),
  host                      TEXT NOT NULL,
  port                      INTEGER NOT NULL DEFAULT 22,
  username                  TEXT NOT NULL,
  -- Exactly one of these two is expected to be set per recipe target
  -- (mirrors EphemeralVmRecipeSshTargetSchema's identityFile/identityAgent
  -- being independently optional) — not enforced by a CHECK here, same
  -- looseness domain.EphemeralVmSshTarget's Go constructor already allows.
  identity_file_vault_path  TEXT,
  identity_agent_vault_path TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One hidden-target record per runtime — Provision (re-)dials the same
-- runtime idempotently, never a second row for the same runtime.
CREATE UNIQUE INDEX idx_ephemeral_vm_ssh_targets_runtime ON infra.ephemeral_vm_ssh_targets (runtime_id);
CREATE INDEX idx_ephemeral_vm_ssh_targets_tenant ON infra.ephemeral_vm_ssh_targets (tenant_id);
