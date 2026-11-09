-- Share links: a public or team-only URL for one port in a workspace VM (src/share-links.ts).
-- The URL token is `id` + an HMAC tag (src/share-crypto.ts); only the id is stored.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes (id),
  account_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  port INTEGER NOT NULL,
  -- `public`: anyone with the link. `team`: signed-in members of the owning account (canView).
  audience TEXT NOT NULL,
  -- Owner opt-in: visitors who can view may also wake a sleeping workspace from the interstitial.
  allow_wake INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_wake_at INTEGER
);
CREATE INDEX share_links_sandbox ON share_links (sandbox_id, created_at);

-- Redeemed one-time team sign-in codes (60s lifetime), so a leaked code can't be replayed.
CREATE TABLE share_enter_codes (
  nonce TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
CREATE INDEX share_enter_codes_used ON share_enter_codes (used_at);

-- Visitor wakes, for the per-workspace daily cap (src/share-links.ts claimShareWake).
CREATE TABLE share_wakes (
  sandbox_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX share_wakes_sandbox ON share_wakes (sandbox_id, at);
