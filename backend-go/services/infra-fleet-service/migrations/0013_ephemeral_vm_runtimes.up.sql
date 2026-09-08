CREATE TABLE infra.ephemeral_vm_runtimes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  repo_id         UUID NOT NULL,              -- logical FK -> project-service's repo, not enforced here (cross-service, per database-per-service rule)
  recipe_id       TEXT NOT NULL,               -- matches OrcaVmRecipe.id from orca.yaml, not a Postgres FK (recipes are repo-authored, not backend-owned rows)
  connection_type TEXT NOT NULL DEFAULT '' CHECK (connection_type IN ('', 'orca-server', 'ssh')),
  status          TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN
                     ('provisioning', 'active', 'suspended', 'error', 'destroyed')),
  environment_id  TEXT,                        -- set once an orca-server-type recipe's pairing succeeds; NULL for ssh-type (permanently blocked, see TASK-006)
  workspace_id    TEXT,                        -- set by AttachWorkspace (TASK-004); NULL until a workspace/worktree is attached
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ephemeral_vm_runtimes_tenant ON infra.ephemeral_vm_runtimes (tenant_id) WHERE status <> 'destroyed';
CREATE INDEX idx_ephemeral_vm_runtimes_repo ON infra.ephemeral_vm_runtimes (repo_id) WHERE status <> 'destroyed';
