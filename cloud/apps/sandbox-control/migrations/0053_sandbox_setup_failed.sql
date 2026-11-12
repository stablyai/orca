-- CREATE-GIT-ASYNC: a create answers once orcad is ready and installs member git identities after.
-- Set when that background setup failed (cleared by the next successful sync); the sandbox view then
-- reports gitSetup 'failed' so the desktop can say why git won't commit or push as the teammate.
ALTER TABLE sandboxes ADD COLUMN git_setup_failed_at INTEGER;
