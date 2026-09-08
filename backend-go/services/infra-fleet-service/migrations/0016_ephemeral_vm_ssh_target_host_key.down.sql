ALTER TABLE infra.ephemeral_vm_ssh_targets
  DROP COLUMN IF EXISTS host_key_fingerprint;
