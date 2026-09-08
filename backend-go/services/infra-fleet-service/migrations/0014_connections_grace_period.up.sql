-- BE-SOL-STORAGE-003 §2 / TASK-BE-STORAGE-009 — additive columns backing the
-- connections degraded/reestablish state machine. degraded_since is set by
-- domain.Connection.MarkDegraded and cleared by Reestablish/CloseExplicitly/
-- CloseAfterGracePeriodExpiry (internal/domain/connection.go); it is never
-- written directly by SQL. grace_period_seconds defaults to 300s — a
-- reasonable starting point for a network blip, not a final product
-- decision (see BE-SOL-STORAGE-003 §2's note on why it does not reuse
-- TS's SshTarget.relayGracePeriodSeconds=86400, a different concept).
ALTER TABLE infra.connections
  ADD COLUMN degraded_since       TIMESTAMPTZ NULL,
  ADD COLUMN grace_period_seconds INTEGER NOT NULL DEFAULT 300;
