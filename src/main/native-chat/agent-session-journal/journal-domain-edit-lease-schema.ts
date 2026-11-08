export const JOURNAL_DOMAIN_EDIT_LEASE_SCHEMA = `
CREATE TABLE journal_edit_leases (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  caller_key TEXT NOT NULL,
  edit_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('waiting','returned')),
  consumed_as TEXT,
  expires_at REAL NOT NULL,
  PRIMARY KEY(session_id, epoch, owner_id, caller_key, edit_id)
) WITHOUT ROWID;
CREATE INDEX journal_edit_leases_message ON journal_edit_leases(session_id, epoch, message_id);
CREATE INDEX journal_edit_leases_deadline ON journal_edit_leases(session_id, epoch, expires_at);
`
