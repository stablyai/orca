CREATE TABLE auth.sso_group_role_mapping (
    id          UUID PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    provider    TEXT NOT NULL,           -- domain.SsoProvider values
    group_name  TEXT NOT NULL,           -- e.g. "orca-admins" (OIDC) or "org:my-company" (GitHub)
    role        TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, group_name)
);

ALTER TABLE auth.sso_group_role_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth.sso_group_role_mapping
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
