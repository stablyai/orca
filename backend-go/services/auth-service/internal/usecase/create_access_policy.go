package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

type CreateAccessPolicyInput struct {
	Name         string
	Kind         string
	DocumentJSON string
}

// CreateAccessPolicy is an admin-console operation — every new policy
// starts at version 1 (auth-service.md:150).
type CreateAccessPolicy struct {
	users     UserRepository
	policies  AccessPolicyRepository
	publisher PolicyDataPublisher
	clock     Clock
	opa       OPAClient
}

func NewCreateAccessPolicy(users UserRepository, policies AccessPolicyRepository, publisher PolicyDataPublisher, clock Clock, opa OPAClient) *CreateAccessPolicy {
	return &CreateAccessPolicy{users: users, policies: policies, publisher: publisher, clock: clock, opa: opa}
}

func (uc *CreateAccessPolicy) Execute(ctx context.Context, in CreateAccessPolicyInput) (domain.AccessPolicy, error) {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return domain.AccessPolicy{}, err
	}

	now := uc.clock.Now()
	policy, err := domain.NewAccessPolicy(uuid.NewString(), in.Name, in.Kind, in.DocumentJSON, 1, actor.ID, now)
	if err != nil {
		return domain.AccessPolicy{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_INVALID_ACCESS_POLICY", err.Error(), err)
	}

	if err := uc.policies.InsertPolicyVersion(ctx, policy); err != nil {
		return domain.AccessPolicy{}, apperrors.New(apperrors.KindInternal, "AUTH_CREATE_ACCESS_POLICY_FAILED", "failed to create access policy", err)
	}

	// Publish the brand-new (version 1) policy to the OPA bundle registry —
	// TASK-BE-027's decision: a newly created policy is exactly the kind of
	// change that needs to take effect immediately, same as an update; there
	// is no "inactive draft" state in this domain (auth-service.md's
	// AccessPolicy invariant treats every version, including the first, as
	// live data OPA bundle sync needs). Mirrors UpdateAccessPolicy's
	// non-blocking posture: a publish failure surfaces as an error but does
	// NOT roll back the just-inserted version row.
	if err := uc.publisher.PublishPolicyChange(ctx, policy); err != nil {
		return domain.AccessPolicy{}, apperrors.New(apperrors.KindInternal, "AUTH_POLICY_PUBLISH_FAILED", "access policy was created but failed to publish to the policy registry", err)
	}
	return policy, nil
}
