# TASK-BE-001: Verify whether `ForceRevokeSession` (single-session admin revoke) actually needs to be added

> **Status: ✅ DONE — 2026-09-11 — gap real, but different shape than guessed (xem "Sửa lại kết luận" bên dưới)**
>
> **Kết luận:** `RevokeSession` (`revoke_session.go`) **đã là** admin-console force-revoke-1-session
> operation từ trước — không phải self-logout path. Bằng chứng trực tiếp:
> - Doc comment của struct `RevokeSession` ghi rõ nguyên văn: *"the admin-console force-revoke operation
>   — distinct from Logout, which only revokes the caller's own session."*
> - `Execute()` gọi `requireAdminActor(ctx, ...)` đầu tiên (admin-gated, không phải self-service).
> - Tra session bằng `uc.sessions.GetSessionByTokenHash(ctx, tokenHash)` từ `sessionToken` truyền vào
>   request — KHÔNG giới hạn ở session của chính actor gọi RPC, có thể là session của bất kỳ user nào.
> - `server.go`'s handler (`RevokeSession`, dòng 309-314) chỉ forward `req.GetSessionToken()` thẳng vào
>   usecase, không có logic tự-giới-hạn nào.
>
> → **Đây chính xác là "ForceRevokeSession" mà BE-SOL-001 nghi ngờ còn thiếu — nó chỉ mang tên khác
> (`RevokeSession`, không phải `ForceRevokeSession`).** Không cần thêm RPC/proto/usecase mới nào.
>
> **Câu hỏi phụ (Teams tab UpdateTeam/DeleteTeam):** xác nhận `tenant.proto` KHÔNG có `UpdateTeam`/
> `DeleteTeam` — chỉ có 6 RPC đã biết (`CreateTeam`, `AddTeamMember`, `ListTeamMembers`,
> `ListTeamsForUser`, `ListTeams`, `RemoveTeamMember`). Tab Teams theo đúng phạm vi đã scope (create/list/
> add-member/remove-member/list-members, không có rename/delete-team) không bị thiếu gì — khớp đúng với
> `TASK-BE-032`'s `admin.*Team*` channel list (không có update/delete team, cố tình).
>
> **⚠️ Sửa lại kết luận (2026-09-11, khi làm TASK-BE-030/Wave 8):** kết luận "gap not real" ở trên **đúng
> một nửa** — đúng về mặt authorization (bất kỳ admin nào cũng revoke được session của bất kỳ user nào,
> không tự giới hạn ở session của chính actor), nhưng **sai về shape identifier**: `usecase.RevokeSession`
> (RPC `RevokeSession`) nhận `sessionToken` — **raw token chưa hash** — rồi tự hash để tra cứu
> (`domain.HashSessionToken(sessionToken)`). Nhưng `ListSessionsForUser`'s `Session.Id` trả về **đã là
> hash** (đúng như comment tại chỗ trong proto: *"opaque token hash, never the raw token"*). Admin xem
> Sessions tab chỉ CÓ hash, KHÔNG BAO GIỜ có raw token của session người khác (đúng thiết kế bảo mật — raw
> token chỉ tồn tại 1 lần, ở người dùng, lúc đăng nhập). Nếu wire thẳng `admin.forceRevokeSession` gọi
> `RevokeSession(session_token: <hash>)`, usecase sẽ hash cái hash đó lần 2 → không bao giờ khớp → RPC
> luôn trả `AUTH_SESSION_NOT_FOUND`, action "kill 1 session" trên UI sẽ luôn thất bại.
>
> **Fix thật (đã implement, xem TASK-BE-002 đã mở lại):** `SessionRepository.RevokeSession(ctx, tokenHash,
> revokedAt)` ở TẦNG REPOSITORY (khác với usecase cùng tên) đã nhận thẳng hash, không tự hash lại — usecase
> mới `ForceRevokeSession` chỉ cần gọi thẳng method này với `session_id` (hash) nhận từ request, admin-gated,
> có audit entry riêng — không đụng gì tới `RevokeSession` cũ (giữ nguyên cho path raw-token nếu có nơi
> khác dùng).

**Solution:** BE-SOL-001 | **CR:** CR-RBAC-001
**Depends on:** BE-SOL-002/005/006 tasks (TASK-BE-003..006, TASK-BE-014..023, TASK-BE-024..027) should
land first — this whole solution is sequenced **last** per the CR set's "Thứ tự thực thi". This
particular task is a read-only investigation, so it has no hard code dependency, but keep it late in
execution order for consistency with the rest of BE-SOL-001.

---

## Goal

BE-SOL-001 is primarily an RPC-surface audit for CR-RBAC-001's planned Admin UI tabs (Users, Policies,
Teams, Sessions, Audit). It found 4/5 tabs fully backed by existing RPCs, but flagged one **unconfirmed**
gap: the Sessions tab needs a single-session "force revoke" admin action, and the audit pass could not
fully confirm whether `RevokeSession` already supports an admin revoking *another* user's session, or
whether a new `ForceRevokeSession` RPC is required (distinct from `ForceRevokeAllSessionsForUser`, which
kills every session for a user).

This task's job is to close that uncertainty with a targeted `codegraph_explore`/read pass — **not** to
implement anything yet.

## What to do

1. Run `codegraph_explore("ForceRevokeSession admin session revoke auth.proto RevokeSession")` (the exact
   query BE-SOL-001 §3 recommends as the first step) against `backend-go/proto/orca/auth/v1/auth.proto`
   and `backend-go/services/auth-service/internal/adapter/grpc/server.go`.
2. Determine definitively:
   - Does `RevokeSession` accept an admin-supplied `session_id`/`session_token` for *any* user, or only
     the caller's own current session (self-logout path)?
   - Is there already an admin gate (`requireAdminActor`) on any single-session revoke path?
3. Also verify the smaller open item from BE-SOL-001 §2 (Teams tab): confirm whether `TenantServiceServer`
   has `UpdateTeam`/`DeleteTeam` RPCs, or whether the Teams tab only needs the 6 RPCs already confirmed
   present (`CreateTeam`, `AddTeamMember`, `RemoveTeamMember`, `ListTeamMembers`, `ListTeams`,
   `ListTeamsForUser`).
4. Write down the conclusion (in the PR/commit description that implements TASK-BE-002, not in this repo)
   as one of two outcomes:
   - **Gap confirmed real** → proceed to TASK-BE-002 exactly as scoped.
   - **Gap not real** (`RevokeSession` already supports an admin target) → TASK-BE-002 is a no-op; close
     it as "not needed, verified during TASK-BE-001" instead of writing new code.

## Acceptance Criteria

- [x] Confirmed (with line references) whether `RevokeSession` supports an admin-supplied target session
      for a user other than the caller. **Yes — it already does.**
- [x] Confirmed whether `UpdateTeam`/`DeleteTeam` exist on `TenantServiceServer`, and if the Teams tab
      needs them. **They don't exist; the scoped Teams tab doesn't need them.**
- [x] No code changed by this task — investigation only.
- [x] Note added to TASK-BE-002: gap not real, closed without new code.

## gitnexus

- Not run with numeric results in BE-SOL-001's pass — the solution explicitly asks for
  `codegraph_explore("ForceRevokeSession admin session revoke auth.proto")` as the first implementation
  step. Run that before concluding either way.
- If the gap is confirmed real, run `impact({target:"ForceRevokeAllSessionsForUser", direction:"upstream"})`
  before writing `ForceRevokeSession` (TASK-BE-002) — BE-SOL-001 §7 flags this as not yet run.

## Blocking

None — read-only. Blocks TASK-BE-002 (which cannot be scoped/started until this task's conclusion is
known).
