# TASK-BE-031: Wire `admin.queryAuditLog` wscompat channel

> **Status: ✅ DONE — 2026-09-11**
>
> **Kết quả thực tế:** TASK-BE-016 (audit filter) đã landed trước khi task này được làm, nên viết thẳng
> bản đầy đủ (`actorId`/`action`/`outcome`) trong 1 pass, không cần 2 bước như BE-SOL-008 §5.2 dự phòng.
> `go build`/`go test` sạch cho `api-gateway`.

**Solution:** BE-SOL-008 §2.3 | **CR:** CR-RBAC-001
**Depends on:** none to implement the base channel (`since` + pagination, matches `QueryAuditLogRequest`
today). TASK-BE-016 (BE-SOL-005's `query_audit_log` filter extension) is a **soft** dependency — see
Blocking for the two-pass plan.

---

## Goal

Wire `QueryAuditLog` to `window.api.admin.queryAuditLog`, forwarding whatever filter fields
`QueryAuditLogRequest` supports at the time this task is picked up.

## What to do

Create `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_audit.go`:

```go
type auditEntryView struct {
	ID               string `json:"id"`
	ActorID          string `json:"actorId"`
	Action           string `json:"action"`
	Target           string `json:"target"`
	Outcome          string `json:"outcome"`   // "" until TASK-BE-014/016 land
	IPAddress        string `json:"ipAddress"` // "" until TASK-BE-014/016 land
	OccurredAtUnixMs int64  `json:"occurredAtUnixMs"`
}

func registerAdminAuditChannels(r *Registry, client authv1.AuthServiceClient) {
	r.Register("admin.queryAuditLog", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type queryArgs struct {
			Since        int64  `json:"since"`
			ActorID      string `json:"actorId"`      // wire once TASK-BE-016 adds this field
			Action       string `json:"action"`
			ResourceType string `json:"resourceType"` // wire once TASK-BE-016 adds this field
			Outcome      string `json:"outcome"`       // wire once TASK-BE-016 adds this field
			PageToken    string `json:"pageToken"`
			PageSize     int32  `json:"pageSize"`
		}
		in := decodeOptionalArg[queryArgs](args, 0)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.QueryAuditLog(rpcCtx, &authv1.QueryAuditLogRequest{
			TenantId: id.TenantID, Since: in.Since, PageToken: in.PageToken, PageSize: in.PageSize,
			// ActorId/Action/ResourceType/Outcome fields added here in a follow-up
			// diff once TASK-BE-016 lands — see this task's "Blocking" note.
		})
		if err != nil {
			return nil, err
		}
		views := make([]auditEntryView, 0, len(resp.GetEntries()))
		for _, e := range resp.GetEntries() {
			views = append(views, auditEntryView{
				ID: e.GetId(), ActorID: e.GetActorId(), Action: e.GetAction(), Target: e.GetTarget(),
				OccurredAtUnixMs: e.GetOccurredAt().AsTime().UnixMilli(),
			})
		}
		return map[string]any{"entries": views, "nextPageToken": resp.GetNextPageToken()}, nil
	})
}
```

Add `registerAdminAuditChannels(r, authClient)` to `RegisterRealChannels` in `channels.go`.

**Two-pass plan** (per BE-SOL-008 §5.2): if TASK-BE-014/015/016 haven't landed yet when this task is
picked up, ship the channel with only `since`+pagination wired (Outcome/ActorID/ResourceType decoded but
silently dropped — do not error on their presence, just don't forward them). Once TASK-BE-016 adds the 3
fields to `QueryAuditLogRequest`, a ~10-line follow-up diff to this same file adds the 3 request-field
mappings and populates `auditEntryView.Outcome`/`IPAddress` from the response.

## Acceptance Criteria

- [ ] `admin.queryAuditLog` channel registered, rejects non-admin `Identity`.
- [ ] Base version (pre-TASK-BE-016) compiles and returns entries filtered by `since`+pagination only.
- [ ] Follow-up diff (post-TASK-BE-016) adds the 3 new filter fields — tracked as a checklist item here,
      not a separate task file, since it's a small addition to an already-created file.
- [ ] `go build ./...` and `go test ./...` clean for `api-gateway`.

## gitnexus

No prior `impact()` run specific to this channel — run
`impact({target:"registerAdminUserChannels", direction:"upstream"})` (same composition-root symbol every
other `admin.*` task in this set checks) before editing `channels.go`.

## Blocking

None for the base version. The 3-field filter extension is soft-blocked on TASK-BE-016 — see "Two-pass
plan" above.
