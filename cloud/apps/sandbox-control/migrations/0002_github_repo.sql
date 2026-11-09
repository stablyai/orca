-- The workspace repository (for GitHub App installation tokens) and when the injected token expires.
ALTER TABLE sandboxes ADD COLUMN repo_url TEXT;
ALTER TABLE sandboxes ADD COLUMN github_token_expires_at INTEGER;
