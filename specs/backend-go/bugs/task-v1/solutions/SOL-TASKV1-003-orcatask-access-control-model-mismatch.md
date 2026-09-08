# SOL-TASKV1-003: OrcaTask access-control model mismatch — see SOL-TG-03

**Resolves:** [BUG-TASKV1-003](../BUG-TASKV1-003-orcatask-access-control-model-mismatch.md)
**Full solution:** [SOL-TG-03-task-access-control](../../logic-v1/solutions/SOL-TG-03-task-access-control.md)
**Status:** 📋 Proposed — not yet implemented

Giải pháp đầy đủ đã được thiết kế tại solution gốc ở trên — KHÔNG lặp lại nội
dung ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn "3 hệ
Task" rằng solution gốc vẫn là hướng fix đúng, chưa implement (re-verified:
`GrantLevel`'s `Owner/Admin/User/Team/Company` enum and
`StubTeamScopeResolver.ResolveTeams`'s hardcoded-empty stub, still wired at
`main.go:86`, are both confirmed unchanged).

## Tóm tắt điểm chính

SOL-TG-03 replaces `StubTeamScopeResolver` with a real implementation
backed by a new `tenant-service.ListTeamsForUser` RPC, adds `ExpiresAt`/
`ID` to `Grant` plus an expiry filter and owner/admin short-circuit in
`ResolveGrant`, and adds `RevokeGrant`/`ListGrants` RPCs plus a grant
audit event published through a new `task-service` outbox adapter. It does
**not** attempt to rename the grantee-kind enum into the doc's
view<comment<edit<execute<manage action scale — SOL-TG-03 treats the
generated proto's grantee-kind shape as the authoritative wire contract
(per its own design-rationale section) and fixes the functionally broken
parts (dead team grants, no expiry/revoke) rather than a wire-breaking
rename.

## Điều chỉnh/bổ sung cần lưu ý

Không có, áp dụng nguyên vẹn solution gốc. `OwnerID`-on-`Task` and the
reporter-auto-grant-on-create gap SOL-TG-03 flags as blocked on
`domain.Task` schema depend on
[SOL-TASKV1-001](./SOL-TASKV1-001-orcatask-data-model-and-state-machine-gap.md)
landing first.
