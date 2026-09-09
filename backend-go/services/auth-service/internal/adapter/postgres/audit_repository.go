package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// Append inserts an audit entry. No Update/Delete method exists on this
// repository — the table is append-only by design (domain.AuditEntry's doc
// comment) and, in production, at the database-permission level too (see
// migrations/0001_init.up.sql's comment on auth.audit_log).
func (r *Repository) Append(ctx context.Context, entry domain.AuditEntry) error {
	var actorID any
	if entry.ActorID != "" {
		actorID = entry.ActorID
	}
	outcome := entry.Outcome
	if outcome == "" {
		outcome = domain.OutcomeAllowed // matches domain.NewAuditEntry's own backward-compatible default
	}
	var ipAddress any
	if entry.IPAddress != "" {
		ipAddress = entry.IPAddress
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO auth.audit_log (id, tenant_id, actor_id, action, target, occurred_at, outcome, ip_address)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
	`, entry.ID, entry.TenantID, actorID, entry.Action, entry.Target, entry.OccurredAt, string(outcome), ipAddress)
	if err != nil {
		return fmt.Errorf("postgres: insert audit entry: %w", err)
	}
	return nil
}

// Query returns entries for tenantID at or after since, optionally narrowed
// by actorID/action/outcome — empty string ("" for actorID/action,
// domain.Outcome("") for outcome) means "no filter" on that dimension,
// matching this codebase's established empty-means-no-filter convention
// (TASK-BE-015; see e.g. ListAnnotations' filePath parameter). Passing all
// three empty preserves the exact query this method ran before these
// filters existed.
func (r *Repository) Query(ctx context.Context, tenantID string, since time.Time, actorID, action string, outcome domain.Outcome, pageToken string, pageSize int32) ([]domain.AuditEntry, string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, COALESCE(actor_id::text, ''), action, target, occurred_at, outcome, COALESCE(host(ip_address), '')
		FROM auth.audit_log
		WHERE tenant_id = $1 AND occurred_at >= $2 AND id::text > $3
		  AND ($4 = '' OR actor_id::text = $4)
		  AND ($5 = '' OR action = $5)
		  AND ($6 = '' OR outcome = $6)
		ORDER BY id
		LIMIT $7
	`, tenantID, since, pageToken, actorID, action, string(outcome), pageSize)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: query audit log: %w", err)
	}
	defer rows.Close()

	var out []domain.AuditEntry
	for rows.Next() {
		var e domain.AuditEntry
		var outcome string
		if err := rows.Scan(&e.ID, &e.TenantID, &e.ActorID, &e.Action, &e.Target, &e.OccurredAt, &outcome, &e.IPAddress); err != nil {
			return nil, "", fmt.Errorf("postgres: scan audit log row: %w", err)
		}
		e.Outcome = domain.Outcome(outcome)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: iterate audit log rows: %w", err)
	}

	next := ""
	if int32(len(out)) == pageSize && len(out) > 0 {
		next = out[len(out)-1].ID
	}
	return out, next, nil
}
