-- Workspace lifecycle (wake, status, archive).
-- orcad's public wss endpoint for the current session (not a secret: pairing still needs the code),
-- and when orcad last became ready, so wake callers can report `readyAt` without a provider call.
ALTER TABLE sandboxes ADD COLUMN orcad_endpoint TEXT;
ALTER TABLE sandboxes ADD COLUMN ready_at INTEGER;
-- Archive = stopped with the snapshot kept for a finite TTL; the cron destroys it after archive_expires_at.
-- (`archived_at` itself comes from 0020_api_routines.sql, already applied on dev.)
ALTER TABLE sandboxes ADD COLUMN archive_expires_at INTEGER;

-- What an archived workspace shows without waking: branch, last commits, changed files, file tree, PRs.
-- Captured in the VM at archive (or sent by the desktop from its cache when the VM was already asleep).
-- Bounded (see archive.ts); deleted with the sandbox.
CREATE TABLE sandbox_archives (
  sandbox_id TEXT PRIMARY KEY REFERENCES sandboxes (id),
  captured_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata TEXT NOT NULL
);
