-- ENV-BUILD-CHURN (d): a golden carries the security level its manifest declared (golden-image.manifest
-- json "securityLevel", bumped by whoever ships a security fix in the image). Environments whose active
-- build sits on a golden below the highest level in its region are rebuilt whatever their use or last
-- refresh, and no workspace boots from such a build (environment-security.ts).
ALTER TABLE golden_images ADD COLUMN security_level INTEGER NOT NULL DEFAULT 0;
