// The 4 GitHub-adjacent starNag.* channels — see channels_star_nag.go's
// doc comment for the split rationale. StarOrcaFromNag/agentValueMoment
// have real (non-empty) response shapes, unlike channels_star_nag.go's 6.
package wscompat

import (
	"context"
	"encoding/json"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

func registerStarNagGitHubChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("starNag.openWeb", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.OpenWebStarNag(attachTenantIdentity(ctx, id), &tenantv1.OpenWebStarNagRequest{UserId: id.UserID})
		return nil, err
	})
	r.Register("starNag.starOrca", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		resp, err := client.StarOrcaFromNag(attachTenantIdentity(ctx, id), &tenantv1.StarOrcaFromNagRequest{UserId: id.UserID})
		if err != nil {
			return nil, err
		}
		return resp.GetStarred(), nil
	})
	r.Register("starNag.agentValueMoment", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// NOTE (confirmed deviation from this RPC's original sketch): the
		// real frontend call site (runtime-star-nag-client.ts's
		// prepareRuntimeStarNagAgentValueMoment) invokes this channel with
		// callRuntimeRpc(target, 'starNag.agentValueMoment', {}) — an empty
		// params object, no appVersion field at all, unlike
		// onboarding.update's FlowVersion (which IS caller-supplied). The
		// "appVersion" arg below is decoded defensively for forward
		// compatibility (and for any future frontend change that starts
		// sending it), but today it will always be "". That degrades
		// PrepareStarNagAgentValueMoment's "one attempt PER app version"
		// gate to "one attempt ever" until the frontend is updated to send
		// a real value — a safe, conservative degradation (never re-fires
		// more often than intended), not a correctness bug, so this RPC
		// still ships rather than blocking on that separate frontend gap.
		var in struct {
			AppVersion string `json:"appVersion"`
		}
		if len(args) > 0 {
			_ = json.Unmarshal(args[0], &in)
		}
		resp, err := client.PrepareStarNagAgentValueMoment(attachTenantIdentity(ctx, id),
			&tenantv1.PrepareStarNagAgentValueMomentRequest{UserId: id.UserID, AppVersion: in.AppVersion})
		if err != nil {
			return nil, err
		}
		return map[string]string{"status": resp.GetStatus(), "mode": resp.GetMode()}, nil
	})
	r.Register("starNag.showAgentValueMoment", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		_, err := client.ShowPreparedStarNagAgentValueMoment(attachTenantIdentity(ctx, id), &tenantv1.ShowPreparedStarNagAgentValueMomentRequest{UserId: id.UserID})
		return nil, err
	})
}
