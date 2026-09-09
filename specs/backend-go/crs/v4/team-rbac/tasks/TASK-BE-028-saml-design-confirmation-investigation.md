# TASK-BE-028: SAML `SsoExchanger` — design-confirmation investigation (Backlog, P3)

> **Status: ✅ DONE — 2026-09-11 (investigation only, per the CR's own Backlog framing — no code written)**
>
> **Kết quả thực tế:** Cả 4 phát hiện của BE-SOL-007 vẫn đúng, re-verify trực tiếp trên code hiện tại
> (sau khi Wave 1-8 đã đổi rất nhiều file `auth-service`):
> 1. **0% SAML code** — `grep -rli saml backend-go/ --include="*.go"` (loại `_test.go`) không ra kết quả
>    nào. Không đổi so với BE-SOL-007.
> 2. **`SsoExchanger` vẫn đúng 2 implementation**, cả 2 vẫn cùng shape OAuth2-code-exchange:
>    `OidcClient.ExchangeAndVerify` (`oidc.go:100`), `GitHubClient.ExchangeAndVerify` (`github.go:113`),
>    cùng signature `(ctx, code, redirectURI, codeVerifier) (VerifiedSsoIdentity, error)`. TASK-BE-007/008
>    (Groups claim) chỉ mở rộng `VerifiedSsoIdentity`, không đổi shape của `SsoExchanger` interface —
>    finding gốc về SAML không khớp interface này **vẫn đúng nguyên vẹn**.
> 3. **`sso_group_role_mapping`** (bảng thật đã tạo ở TASK-BE-009, migration `0006_sso_group_role_mapping.up.sql`)
>    xác nhận `provider TEXT NOT NULL` và `group_name TEXT NOT NULL` — **plain string, không phải Postgres
>    ENUM** — đúng như BE-SOL-007 dự đoán: 1 dòng `provider = 'saml'` trong tương lai không cần migration.
> 4. Không có code nào được viết — đúng phạm vi task.
>
> **Kết luận cho người nhận việc tiếp theo (nếu product owner xác nhận cần SAML):** câu hỏi thiết kế đầu
> tiên vẫn y nguyên — `SsoExchanger` cần tách thành "build redirect"/"verify assertion" tổng quát hơn,
> hoặc SAML cần 1 port riêng hình dạng khác — chưa ai giải quyết, không thuộc phạm vi task này.

**Solution:** BE-SOL-007 | **CR:** CR-RBAC-007
**Priority:** ⚪ P3 Backlog — do not implement without product-owner confirmation that SAML is actually
needed (most modern IdPs support OIDC, already fully built per BE-SOL-003/TASK-BE-007..012).
**Depends on:** TASK-BE-009 (SSO group-role mapping table should exist and be provider-agnostic before
reasoning further about SAML reuse — already confirmed compatible in BE-SOL-003 §7 without schema
changes, since `provider`/`group_name` are plain strings).

---

## What this task is (and is not)

This mirrors the shape of `specs/agent/crs/v3/project-workspace/tasks/TASK-AG-PW-001-execution-progress-reporting-investigation.md`
— a **light investigation/design-confirmation pass**, not a chunked implementation plan. CR-RBAC-007 is
explicitly Backlog, effort-large, and waiting on a product decision about whether SAML is even needed.
Writing a full task breakdown for a feature that may never be built is not a good use of effort — this
task exists to record the one concrete technical finding future work needs, and to confirm nothing has
drifted since BE-SOL-007 was written.

## What to do

1. Confirm (re-verify, don't assume stale) that `backend-go/` still has 0% SAML code —
   `codegraph_explore("saml SsoExchanger")` should return no `saml` package/reference outside
   documentation.
2. Confirm `internal/usecase/ports.go`'s `SsoExchanger` interface is still implemented by exactly 2 types
   (`oidc.go`, `github.go`) and that both still return the same `VerifiedSsoIdentity` shape TASK-BE-007
   extends with `Groups`.
3. Re-confirm the one real technical finding BE-SOL-007 already made, and correct it if the codebase has
   moved since: **SAML's browser flow (IdP POSTs a signed assertion directly to an ACS endpoint) doesn't
   map onto `SsoExchanger.ExchangeAndVerify(code, redirectURI, codeVerifier)`'s OAuth2-code-exchange
   shape.** This means `SsoExchanger`'s interface itself likely needs to change (e.g. split into "build
   redirect" + "verify assertion" methods generic enough for both shapes, or SAML gets a parallel,
   differently-shaped port) — this is the first real design question whoever picks this up needs to
   resolve, not resolved here.
4. Confirm `sso_group_role_mapping` (TASK-BE-009) remains schema-compatible with a future SAML
   `provider = "saml"` row (attribute-based group equivalents) without a migration — should still be true
   since `provider`/`group_name` are plain strings, not an enum.
5. Do **not** design signature verification, clock-skew handling, metadata exchange UI, or the
   `SsoExchanger` interface split any further than confirming the question exists — leave that to whoever
   picks this up once product confirms the need.

## Acceptance Criteria

- [x] Confirmed (or corrected, if drifted) that 0% SAML code exists in `backend-go/`.
- [x] Confirmed `SsoExchanger` still has exactly 2 implementations, both OAuth2-code-exchange-shaped.
- [x] Confirmed (or corrected) the `SsoExchanger` interface-shape mismatch finding is still accurate.
- [x] Confirmed `sso_group_role_mapping`'s schema (landed at TASK-BE-009) needs no migration to support a
      future `provider = "saml"` row — verified against the real migration SQL.
- [x] No code implemented — this is a documented, deliberate non-goal for this task, consistent with the
      CR's own "Backlog, cần product owner xác nhận nhu cầu" framing.

## gitnexus

Not applicable in BE-SOL-007's original pass — no existing symbol is modified, this is a new-feature,
backlog-only design note. If re-running this investigation later, `codegraph_explore("SsoExchanger
ExchangeAndVerify")` is the fastest way to reconfirm the 2-implementation, OAuth2-shaped-interface finding
above.

## Blocking

None for the rest of this task set (nothing else depends on SAML). This task itself is blocked on
product-owner confirmation that SAML is needed at all before any *implementation* task should be written
— that confirmation is outside this task's scope to obtain.
