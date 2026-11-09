-- Org / personal / repo secrets, envelope-encrypted (src/secrets-crypto.ts). Plaintext never lands
-- here: `ciphertext` is AES-256-GCM under a per-row DEK, `wrapped_dek` is that DEK under the KEK
-- `kek_id` (a Worker secret). Both are bound to (scope, owner_id, name) as AAD.
CREATE TABLE secrets (
  scope TEXT NOT NULL CHECK (scope IN ('org', 'personal', 'repo')),
  -- org: the org account id; personal: user:<id>; repo: <account id>#<github.com/owner/repo>.
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kek_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  -- Last 4 characters of long values, for recognising a key in the UI; null for short values.
  hint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, owner_id, name)
);

-- Credential hosts whose real key the egress proxy swaps in for this session (comma list).
ALTER TABLE sandboxes ADD COLUMN egress_secret_hosts TEXT;
