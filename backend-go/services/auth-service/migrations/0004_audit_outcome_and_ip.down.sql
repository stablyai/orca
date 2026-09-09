DROP INDEX IF EXISTS auth.idx_audit_log_outcome;
ALTER TABLE auth.audit_log DROP COLUMN IF EXISTS outcome, DROP COLUMN IF EXISTS ip_address;
