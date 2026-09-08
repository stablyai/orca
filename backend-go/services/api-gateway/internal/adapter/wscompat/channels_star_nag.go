// Channel handlers backing the frontend's starNag.* namespace — see
// specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md.
// This file covers the 6 pure state-mutation RPCs (dismiss/later/complete/
// disable/forceShow/onboardingCompleted); the 4 GitHub-adjacent RPCs
// (openWeb/starOrca/agentValueMoment/showAgentValueMoment) and the
// subscribe/unsubscribe streaming pair are wired from their own files —
// see channels_star_nag_github.go (TASK-012) and
// channels_star_nag_visibility.go (TASK-014, not yet landed). registerStarNagChannels
// is the entry point channels.go's RegisterRealChannels calls.
package wscompat

import (
	"context"
	"encoding/json"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

func attachTenantIdentity(ctx context.Context, id Identity) context.Context {
	return gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
}

func registerStarNagChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("starNag.dismiss", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.DismissStarNag(attachTenantIdentity(ctx, id), &tenantv1.DismissStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.later", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.DeferStarNag(attachTenantIdentity(ctx, id), &tenantv1.DeferStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.complete", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.CompleteStarNag(attachTenantIdentity(ctx, id), &tenantv1.CompleteStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.disable", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.DisableStarNag(attachTenantIdentity(ctx, id), &tenantv1.DisableStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.forceShow", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.ForceShowStarNag(attachTenantIdentity(ctx, id), &tenantv1.ForceShowStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.onboardingCompleted", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.NotifyStarNagOnboardingCompleted(attachTenantIdentity(ctx, id), &tenantv1.NotifyStarNagOnboardingCompletedRequest{UserId: id.UserID})
		return nil, err
	})
}
