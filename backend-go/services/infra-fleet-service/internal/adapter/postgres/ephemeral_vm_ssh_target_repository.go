package postgres

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// EphemeralVmSshTargetStore implements usecase.EphemeralVmSshTargetRepository
// against infra.ephemeral_vm_ssh_targets (migrations/0015) —
// TASK-BE-EVM-014's Hướng A audit/at-rest record, separate table/struct
// from SshTargetStore's infra.ssh_targets for the same reason
// BE-SOL-EVM-004 §2 gives for not reusing that table: different lifecycle,
// different write-owner (recipe-provisioned vs. user-registered).
type EphemeralVmSshTargetStore struct {
	pool *pgxpool.Pool
}

func NewEphemeralVmSshTargetStore(pool *pgxpool.Pool) *EphemeralVmSshTargetStore {
	return &EphemeralVmSshTargetStore{pool: pool}
}

// Upsert inserts or updates the one row for record.RuntimeID (unique index
// idx_ephemeral_vm_ssh_targets_runtime) — see
// usecase.EphemeralVmSshTargetRepository's doc comment for why Provision
// re-running for the same runtime is expected, not an error case.
func (s *EphemeralVmSshTargetStore) Upsert(ctx context.Context, record domain.EphemeralVmSshTargetRecord) (domain.EphemeralVmSshTargetRecord, error) {
	if record.ID == "" {
		record.ID = uuid.NewString()
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO infra.ephemeral_vm_ssh_targets
			(id, tenant_id, runtime_id, host, port, username, identity_file_vault_path, identity_agent_vault_path, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (runtime_id) DO UPDATE SET
			host = EXCLUDED.host,
			port = EXCLUDED.port,
			username = EXCLUDED.username,
			identity_file_vault_path = EXCLUDED.identity_file_vault_path,
			identity_agent_vault_path = EXCLUDED.identity_agent_vault_path,
			updated_at = now()
	`, record.ID, record.TenantID, record.RuntimeID, record.Host, record.Port, record.Username,
		nullableText(record.IdentityFileVaultPath), nullableText(record.IdentityAgentVaultPath))
	if err != nil {
		return domain.EphemeralVmSshTargetRecord{}, fmt.Errorf("postgres: upsert ephemeral vm ssh target: %w", err)
	}
	return record, nil
}

// Get fetches the hidden-target audit row for (tenantID, runtimeID).
// found=false with a nil error means "no dial has been recorded for this
// runtime yet" — not a failure the caller needs to branch on differently.
func (s *EphemeralVmSshTargetStore) Get(ctx context.Context, tenantID, runtimeID string) (domain.EphemeralVmSshTargetRecord, bool, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, tenant_id, runtime_id, host, port, username,
		       COALESCE(identity_file_vault_path, ''), COALESCE(identity_agent_vault_path, '')
		FROM infra.ephemeral_vm_ssh_targets
		WHERE tenant_id = $1 AND runtime_id = $2
	`, tenantID, runtimeID)

	var rec domain.EphemeralVmSshTargetRecord
	if err := row.Scan(&rec.ID, &rec.TenantID, &rec.RuntimeID, &rec.Host, &rec.Port, &rec.Username,
		&rec.IdentityFileVaultPath, &rec.IdentityAgentVaultPath); err != nil {
		if err == pgx.ErrNoRows {
			return domain.EphemeralVmSshTargetRecord{}, false, nil
		}
		return domain.EphemeralVmSshTargetRecord{}, false, fmt.Errorf("postgres: get ephemeral vm ssh target: %w", err)
	}
	return rec, true, nil
}

// nullableText converts an empty string to a real SQL NULL — mirrors this
// package's existing convention elsewhere (e.g. EphemeralVmRuntimeStore's
// COALESCE-on-read pairing) so an unset vault path reads back as "", not a
// literal empty string stored in the column.
func nullableText(s string) any {
	if s == "" {
		return nil
	}
	return s
}
