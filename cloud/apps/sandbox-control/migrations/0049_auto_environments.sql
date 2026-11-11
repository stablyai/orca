-- Automatic environments (src/auto-environments.ts): the first create of a repo that no environment
-- lists makes a default environment for it (just the repo) and builds it in the background, so later
-- creates boot with the repo already checked out. 'org' rows are made or edited by an admin; 'auto' rows
-- were made by the system and are deleted after 14 days without a create (an admin's edit makes them 'org').
ALTER TABLE environments ADD COLUMN kind TEXT NOT NULL DEFAULT 'org';
-- Last create that booted from this environment (or asked for one for its repo).
ALTER TABLE environments ADD COLUMN last_used_at INTEGER;
CREATE INDEX environments_kind ON environments (kind, deleted_at);
