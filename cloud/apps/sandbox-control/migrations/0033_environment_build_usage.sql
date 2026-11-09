-- Build VMs are metered like workspaces: one usage segment per finished build (createdAt..finishedAt,
-- the build's sandbox size), attributed to the member who started it. Null until billing accepted it;
-- the cron retries unreported builds.
ALTER TABLE environment_builds ADD COLUMN usage_reported_at INTEGER;
CREATE INDEX environment_builds_unreported ON environment_builds (usage_reported_at, finished_at);
