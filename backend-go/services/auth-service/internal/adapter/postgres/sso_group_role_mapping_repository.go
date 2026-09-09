package postgres

import (
	"context"
	"fmt"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// Upsert inserts a new auth.sso_group_role_mapping row, or updates role on
// an existing (tenant_id, provider, group_name) row — mirrors the table's
// UNIQUE constraint via ON CONFLICT, matching UpdateSsoGroupMapping's
// "admin-editable, single RPC" contract (CR-RBAC-003/TASK-BE-009).
func (r *Repository) Upsert(ctx context.Context, m domain.SsoGroupRoleMapping) (domain.SsoGroupRoleMapping, error) {
	row := r.pool.QueryRow(ctx, `
		INSERT INTO auth.sso_group_role_mapping (id, tenant_id, provider, group_name, role, created_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (tenant_id, provider, group_name) DO UPDATE SET role = EXCLUDED.role
		RETURNING id, tenant_id, provider, group_name, role, created_at
	`, m.ID, m.TenantID, string(m.Provider), m.GroupName, string(m.Role), m.CreatedAt)

	var out domain.SsoGroupRoleMapping
	var provider, role string
	if err := row.Scan(&out.ID, &out.TenantID, &provider, &out.GroupName, &role, &out.CreatedAt); err != nil {
		return domain.SsoGroupRoleMapping{}, fmt.Errorf("postgres: upsert sso group role mapping: %w", err)
	}
	out.Provider = domain.SsoProvider(provider)
	out.Role = domain.Role(role)
	return out, nil
}

// ListForProvider returns every mapping row for tenantID, optionally
// narrowed to one provider — empty provider means "every provider".
func (r *Repository) ListForProvider(ctx context.Context, tenantID string, provider domain.SsoProvider) ([]domain.SsoGroupRoleMapping, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, provider, group_name, role, created_at
		FROM auth.sso_group_role_mapping
		WHERE tenant_id = $1 AND ($2 = '' OR provider = $2)
		ORDER BY provider, group_name
	`, tenantID, string(provider))
	if err != nil {
		return nil, fmt.Errorf("postgres: query sso group role mappings: %w", err)
	}
	defer rows.Close()

	var out []domain.SsoGroupRoleMapping
	for rows.Next() {
		var m domain.SsoGroupRoleMapping
		var providerStr, role string
		if err := rows.Scan(&m.ID, &m.TenantID, &providerStr, &m.GroupName, &role, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan sso group role mapping row: %w", err)
		}
		m.Provider = domain.SsoProvider(providerStr)
		m.Role = domain.Role(role)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate sso group role mapping rows: %w", err)
	}
	return out, nil
}
