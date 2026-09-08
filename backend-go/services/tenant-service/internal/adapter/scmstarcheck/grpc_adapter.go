// GrpcAdapter implements usecase.ScmStarCheckPort against
// scm-integration-service's real StarRepository RPC (SOL-012/TASK-034/035).
// See TASK-013 (specs/backend-go/bugs/missing-v3/tasks/) for why this file
// didn't exist before that RPC landed.
package scmstarcheck

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"

	"github.com/stablyai/orca-go/common/tenant"
)

// orcaRepoSlug is the one repo starNag.starOrca/agentValueMoment ever
// checks/stars — same hardcoded slug api-gateway's channels_scm.go uses for
// github.starOrca (this service's own tenant-scoped caller of the same
// underlying RPC).
const orcaRepoSlug = "getorca/orca"

// Dial opens a gRPC client connection to scm-integration-service at addr —
// tenant-service's first outbound synchronous service dependency (see
// cmd/server/main.go's wiring comment). Same lazy-dial, insecure-transport
// pattern as every other service's own internal/adapter/grpcclient.Dial
// (e.g. git-gateway-service's) — acceptable for local dev only, a
// production mTLS gap shared with every other Dial helper in this
// codebase.
func Dial(addr string) (*grpc.ClientConn, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("scmstarcheck: dial scm-integration-service at %q: %w", addr, err)
	}
	return conn, nil
}

// GrpcAdapter implements usecase.ScmStarCheckPort against the real
// ScmIntegrationService.StarRepository RPC. Replaces StubAdapter once that
// RPC exists — see this package's TASK-013 (specs/backend-go/bugs/
// missing-v3/tasks/) for why this file didn't exist before then.
type GrpcAdapter struct {
	client scmintegrationv1.ScmIntegrationServiceClient
}

func NewGrpcAdapter(client scmintegrationv1.ScmIntegrationServiceClient) *GrpcAdapter {
	return &GrpcAdapter{client: client}
}

// CheckStarred always degrades to ok=false — confirmed against the real,
// merged scmintegration.proto (not TASK-013's original guess): SOL-012
// shipped ONLY StarRepository (a "star" action, GitHub's PUT
// /user/starred/{owner}/{repo}), not a check-only sibling RPC — that
// proto's own StarRepository RPC doc comment explicitly flags
// "CheckRepositoryStarred... out of this task's scope, a low-cost follow-up
// once this lands." Calling StarRepository here to "check" would actually
// PERFORM the star action as a side effect of a read — not an acceptable
// substitute — so this stays an honest "unable to determine" (ok=false)
// answer, the same designed degrade every other star-nag path already
// uses, until that follow-up RPC exists.
func (a *GrpcAdapter) CheckStarred(ctx context.Context, userID string) (starred bool, ok bool) {
	return false, false
}

// StarRepository stars orcaRepoSlug on behalf of the caller's tenant's
// connected GitHub OAuth account — scm-integration-service's
// CredentialResolver resolves per (tenantID, provider), not per user
// (confirmed at scm-integration-service's ports.go), so userID is accepted
// (to satisfy ScmStarCheckPort's shape) but not forwarded on the request.
// ok=false on any RPC error or missing tenant in context — never treat an
// error as "confirmed not starred," which would be a false negative
// surfaced to the user as real information.
func (a *GrpcAdapter) StarRepository(ctx context.Context, userID string) (starred bool, ok bool) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return false, false
	}
	resp, err := a.client.StarRepository(ctx, &scmintegrationv1.StarRepositoryRequest{
		TenantId: tenantID,
		Provider: scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB,
		Repo:     orcaRepoSlug,
	})
	if err != nil {
		return false, false
	}
	return resp.GetStarred(), true
}
