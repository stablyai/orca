// Package policypublisher implements usecase.PolicyDataPublisher — the port
// UpdateAccessPolicy uses to push a newly-versioned AccessPolicy to the OPA
// bundle registry (auth-service.md:194). No real OPA bundle-registry
// integration exists in this codebase yet (see internal/adapter/opaclient,
// which only ever evaluates the embedded admin.rego decision — it never
// publishes bundle data), so NoopPublisher is a logging-only stand-in kept
// behind the same interface UpdateAccessPolicy already depends on, so
// swapping in a real bundle-registry client later touches only
// cmd/server/main.go's wiring, not usecase code.
package policypublisher

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/stablyai/orca-go/common/policy"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// NoopPublisher logs that a policy changed but does not push it anywhere —
// see package doc comment for why this is a deliberate stub, not an
// oversight. Kept in this package, unmodified, alongside FilePublisher below
// (TASK-BE-025) for tests that don't need real publish behavior.
type NoopPublisher struct {
	Logger *slog.Logger
}

func New(logger *slog.Logger) *NoopPublisher {
	return &NoopPublisher{Logger: logger}
}

func (p *NoopPublisher) PublishPolicyChange(ctx context.Context, policy domain.AccessPolicy) error {
	if p.Logger != nil {
		p.Logger.WarnContext(ctx, "policypublisher: OPA bundle registry not wired yet — policy change was persisted but NOT published",
			slog.String("policy_id", policy.ID), slog.Int("version", int(policy.Version)))
	}
	return nil
}

// FilePublisher implements usecase.PolicyDataPublisher by writing an
// AccessPolicy's document_json to <bundlePath>/data/<kind>/<name>.json — a
// plain data file the shared rego.Load bundle-directory walk
// (common/policy.Evaluator) already merges alongside the .rego sources when
// pointed at a directory, so no real OPA bundle-registry service is needed
// for a policy change to actually take effect (TASK-BE-025/CR-RBAC-006,
// paired with TASK-BE-024's self-invalidation so a running Evaluator picks
// the write up without a restart).
type FilePublisher struct {
	bundlePath string
	evaluator  *policy.Evaluator
}

// NewFilePublisher wires a FilePublisher to bundlePath (the same directory
// every consuming service's Evaluator is pointed at) and evaluator (used
// only for ValidateBundleAt's compile check below — never for a real
// Decision, so validating a candidate write can never disturb that
// Evaluator's own cached decisions, per ValidateBundleAt's doc comment).
func NewFilePublisher(bundlePath string, evaluator *policy.Evaluator) *FilePublisher {
	return &FilePublisher{bundlePath: bundlePath, evaluator: evaluator}
}

// PublishPolicyChange validates policy.DocumentJSON is well-formed JSON,
// validates the WHOLE bundle (existing .rego + this new/changed data file)
// still compiles, and only then writes it — atomically (temp file +
// rename), so a concurrently-reloading Evaluator can never observe a
// partial write. No file is written on either validation failure.
func (p *FilePublisher) PublishPolicyChange(ctx context.Context, pol domain.AccessPolicy) error {
	var doc any
	if err := json.Unmarshal([]byte(pol.DocumentJSON), &doc); err != nil {
		return fmt.Errorf("policypublisher: policy %s document is not valid JSON: %w", pol.ID, err)
	}

	relPath := filepath.Join("data", pol.Kind, pol.Name+".json")
	if err := p.validateCompiles(ctx, relPath, []byte(pol.DocumentJSON)); err != nil {
		return fmt.Errorf("policypublisher: policy %s would break the OPA bundle: %w", pol.ID, err)
	}

	return atomicWriteFile(filepath.Join(p.bundlePath, relPath), []byte(pol.DocumentJSON))
}

// validateCompiles copies bundlePath into a throwaway temp directory,
// writes the candidate file at relPath within that copy, and asks
// ValidateBundleAt to confirm the copy still compiles — so a bad write is
// rejected BEFORE it ever touches the real, shared bundle path every
// service reads, and without perturbing p.evaluator's own cached state
// (ValidateBundleAt's doc comment).
func (p *FilePublisher) validateCompiles(ctx context.Context, relPath string, content []byte) error {
	tmpDir, err := os.MkdirTemp("", "orca-authz-bundle-candidate-*")
	if err != nil {
		return fmt.Errorf("creating temp validation dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	if err := copyDir(p.bundlePath, tmpDir); err != nil {
		return fmt.Errorf("copying bundle for validation: %w", err)
	}

	candidatePath := filepath.Join(tmpDir, relPath)
	if err := os.MkdirAll(filepath.Dir(candidatePath), 0o755); err != nil {
		return fmt.Errorf("creating candidate data directory: %w", err)
	}
	if err := os.WriteFile(candidatePath, content, 0o644); err != nil {
		return fmt.Errorf("writing candidate file: %w", err)
	}

	return p.evaluator.ValidateBundleAt(ctx, tmpDir)
}

// copyDir recursively copies src's file tree into dst (both must already
// exist or be creatable) — used to build a disposable bundle copy for
// validateCompiles so the real, shared bundlePath is never touched by a
// candidate write until it's proven to compile.
func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, content, 0o644)
	})
}

// atomicWriteFile writes content to path via a temp file in the same
// directory followed by os.Rename — POSIX guarantees rename is atomic
// within one filesystem, so a concurrently-reloading Evaluator (which just
// re-stats/re-reads the directory tree, see common/policy.Evaluator's
// invalidateIfBundleChanged) can never observe a partially-written file.
func atomicWriteFile(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating data directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once Rename below succeeds

	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("renaming temp file into place: %w", err)
	}
	return nil
}
