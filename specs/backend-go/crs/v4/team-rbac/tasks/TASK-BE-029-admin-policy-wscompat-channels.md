# TASK-BE-029: Wire `admin.*Policy*` wscompat channels

> **Status: ✅ DONE — 2026-09-11**
>
> **Kết quả thực tế:** 5 channel đăng ký trong `channels_admin_policies.go` (mới), theo đúng sketch — chỉ
> sửa 2 điểm sau khi xác nhận field proto thật: `GetAccessPolicyRequest`/`DeleteAccessPolicyRequest` dùng
> `Id` (không phải `PolicyId`), và `UpdateAccessPolicyRequest` cần thêm `ExpectedVersion` (optimistic
> concurrency — không có trong sketch gốc). `go build`/`go test` sạch cho `api-gateway`, `gofmt -l` sạch.

**Solution:** BE-SOL-008 §2.1 | **CR:** CR-RBAC-001
**Depends on:** TASK-BE-001/002 having landed (BE-SOL-001's admin RPC surface audit — no gap expected
here since `CreateAccessPolicy`/`GetAccessPolicy`/`ListAccessPolicies`/`UpdateAccessPolicy`/
`DeleteAccessPolicy` were all confirmed already present on `AuthServiceServer`). Does **not** need to wait
for TASK-BE-024..027 (BE-SOL-006's policy-publish fix) to be *implemented* — see Blocking.

---

## Goal

`channels_admin_users.go` is the only `admin.*` wscompat file that exists today. Add a new file wiring
the 5 `AccessPolicy` CRUD RPCs (all already implemented server-side, confirmed by BE-SOL-001) to
`window.api.admin.*`, mirroring `registerAdminUserChannels`'s exact shape (admin-gate first line, decode
args, `gatewaygrpc.AttachIdentity`, call the gRPC client, return a camelCase view struct).

## What to do

Create `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_policies.go`:

```go
package wscompat

import (
	"context"
	"encoding/json"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type policyView struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	DocumentJSON    string `json:"documentJson"`
	Version         int32  `json:"version"`
	UpdatedBy       string `json:"updatedBy"`
	UpdatedAtUnixMs int64  `json:"updatedAtUnixMs"`
}

func toPolicyView(p *authv1.AccessPolicy) policyView {
	var updatedAtUnixMs int64
	if ts := p.GetUpdatedAt(); ts != nil {
		updatedAtUnixMs = ts.AsTime().UnixMilli()
	}
	return policyView{
		ID: p.GetId(), Name: p.GetName(), Kind: p.GetKind(),
		DocumentJSON: p.GetDocumentJson(), Version: p.GetVersion(),
		UpdatedBy: p.GetUpdatedBy(), UpdatedAtUnixMs: updatedAtUnixMs,
	}
}

func registerAdminPolicyChannels(r *Registry, client authv1.AuthServiceClient) {
	r.Register("admin.listPolicies", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type listArgs struct {
			PageToken string `json:"pageToken"`
			PageSize  int32  `json:"pageSize"`
		}
		in := decodeOptionalArg[listArgs](args, 0)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListAccessPolicies(rpcCtx, &authv1.ListAccessPoliciesRequest{
			PageToken: in.PageToken, PageSize: in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		views := make([]policyView, 0, len(resp.GetPolicies()))
		for _, p := range resp.GetPolicies() {
			views = append(views, toPolicyView(p))
		}
		return map[string]any{"policies": views, "nextPageToken": resp.GetNextPageToken()}, nil
	})

	r.Register("admin.getPolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type getArgs struct {
			PolicyID string `json:"policyId"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetAccessPolicy(rpcCtx, &authv1.GetAccessPolicyRequest{PolicyId: in.PolicyID})
		if err != nil {
			return nil, err
		}
		return toPolicyView(resp), nil
	})

	r.Register("admin.createPolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type createArgs struct {
			Name         string `json:"name"`
			Kind         string `json:"kind"`
			DocumentJSON string `json:"documentJson"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateAccessPolicy(rpcCtx, &authv1.CreateAccessPolicyRequest{
			Name: in.Name, Kind: in.Kind, DocumentJson: in.DocumentJSON,
		})
		if err != nil {
			return nil, err
		}
		return toPolicyView(resp), nil
	})

	r.Register("admin.updatePolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type updateArgs struct {
			PolicyID     string `json:"policyId"`
			DocumentJSON string `json:"documentJson"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateAccessPolicy(rpcCtx, &authv1.UpdateAccessPolicyRequest{
			PolicyId: in.PolicyID, DocumentJson: in.DocumentJSON,
		})
		if err != nil {
			return nil, err
		}
		return toPolicyView(resp), nil
	})

	r.Register("admin.deletePolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type deleteArgs struct {
			PolicyID string `json:"policyId"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		_, err = client.DeleteAccessPolicy(rpcCtx, &authv1.DeleteAccessPolicyRequest{PolicyId: in.PolicyID})
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}
```

Then, in `channels.go`, add `registerAdminPolicyChannels(r, authClient)` to `RegisterRealChannels`, next
to the existing `registerAdminUserChannels(r, authClient, tenantClient)` call.

**Before writing this file**, run `codegraph_explore` on `AccessPolicy`/`CreateAccessPolicyRequest`/
`ListAccessPoliciesRequest`'s actual generated Go field names (`.pb.go`) — the sketch above assumes
`DocumentJson`/`Kind`/`UpdatedAt`/`UpdatedBy` proto field names by analogy with BE-SOL-006's description
of `AccessPolicy`; confirm exact casing/field presence before compiling.

## Acceptance Criteria

- [ ] 5 channels registered: `admin.listPolicies`, `.getPolicy`, `.createPolicy`, `.updatePolicy`,
      `.deletePolicy`.
- [ ] Each rejects non-admin `Identity` with `errNotAdmin` (test per channel, mirroring
      `channels_admin_users_test.go`'s `TestAdminCreateUserChannel_RequiresAdmin` pattern).
- [ ] `go build ./...` and `go test ./...` clean for `api-gateway`.
- [ ] `gofmt -l` clean on the new file.

## gitnexus

Run `impact({target:"registerAdminUserChannels", direction:"upstream"})` before editing `channels.go`
(BE-SOL-008's own pass found: risk LOW, impactedCount 3, 1 direct, 1 process `run` affected) — re-confirm
this hasn't changed since, then add the new call alongside it.

## Blocking

None to *implement* this task. **Functional note, not a blocker**: policy edits made through these
channels have no real enforcement effect until TASK-BE-025/027 (BE-SOL-006's `NoopPublisher` replacement)
land — document this in the frontend Policies tab (FE-TASK-018 or equivalent) as a known limitation if
this task ships first.
