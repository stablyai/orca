package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// DeleteAccessPolicy is an admin-console operation — removes every version
// row for a policy id.
type DeleteAccessPolicy struct {
	users     UserRepository
	policies  AccessPolicyRepository
	publisher PolicyDataPublisher
	clock     Clock
	opa       OPAClient
}

func NewDeleteAccessPolicy(users UserRepository, policies AccessPolicyRepository, publisher PolicyDataPublisher, clock Clock, opa OPAClient) *DeleteAccessPolicy {
	return &DeleteAccessPolicy{users: users, policies: policies, publisher: publisher, clock: clock, opa: opa}
}

func (uc *DeleteAccessPolicy) Execute(ctx context.Context, id string) error {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return err
	}
	if id == "" {
		return apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_POLICY_ID", "id is required", nil)
	}

	// Fetch the current row (if any) BEFORE deleting — needed for its
	// kind/name to retract the right bundle file below. DeletePolicy itself
	// stays idempotent (no error deleting an already-absent id, matching its
	// prior behavior) — a missing policy here just means there is nothing to
	// retract, not a failure.
	current, getErr := uc.policies.GetLatestPolicy(ctx, id)
	hadPolicy := getErr == nil

	if err := uc.policies.DeletePolicy(ctx, id); err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_DELETE_ACCESS_POLICY_FAILED", "failed to delete access policy", err)
	}
	if !hadPolicy {
		return nil
	}

	// TASK-BE-027's decision: a deleted policy must stop being enforced, not
	// remain live in the OPA bundle forever — but PolicyDataPublisher has
	// only PublishPolicyChange, no dedicated "unpublish." Retraction is
	// modeled as publishing an emptied document at the SAME kind/name bundle
	// path: any data.<kind>.<name> rule that depended on this policy's
	// content now sees an empty object, the same "no policy" state a rule
	// sees before the policy ever existed. Same non-blocking posture as
	// Create/UpdateAccessPolicy: a publish failure surfaces as an error but
	// does NOT undo the already-committed deletion.
	tombstone, err := domain.NewAccessPolicy(current.ID, current.Name, current.Kind, "{}", current.Version+1, actor.ID, uc.clock.Now())
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_POLICY_RETRACT_FAILED", "access policy was deleted but failed to build its retraction record", err)
	}
	if err := uc.publisher.PublishPolicyChange(ctx, tombstone); err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_POLICY_PUBLISH_FAILED", "access policy was deleted but failed to retract from the policy registry", err)
	}
	return nil
}
