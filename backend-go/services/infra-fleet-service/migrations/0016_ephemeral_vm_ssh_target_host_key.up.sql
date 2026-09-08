-- TASK-BE-EVM-019 (Hướng B) — TOFU (trust-on-first-use) host-key
-- verification for adapter/ephemeralsshconn.Connector, BE-SOL-EVM-004 §6d.
-- Reuses infra.ephemeral_vm_ssh_targets (migrations/0015) — same one-row-
-- per-runtime shape TASK-BE-EVM-014's Hướng A audit row already uses; a
-- given runtime is provisioned by exactly one of Hướng A/B (server-wide
-- EPHEMERAL_VM_SSH_MODE config), so no write-owner conflict between them.
ALTER TABLE infra.ephemeral_vm_ssh_targets
  ADD COLUMN host_key_fingerprint TEXT;
