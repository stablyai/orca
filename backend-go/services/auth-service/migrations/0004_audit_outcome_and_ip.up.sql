ALTER TABLE auth.audit_log
    ADD COLUMN outcome     TEXT NOT NULL DEFAULT 'allowed' CHECK (outcome IN ('allowed', 'denied')),
    ADD COLUMN ip_address  INET;

CREATE INDEX idx_audit_log_outcome ON auth.audit_log (tenant_id, outcome);
