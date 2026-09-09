# TASK-BE-008: GitHub org membership → `VerifiedSsoIdentity.Groups`

> **Status: ✅ DONE — 2026-09-11**
>
> **Kết quả thực tế:** Đúng như kế hoạch — `github.go` gọi `GET /user/orgs` sau khi resolve subject/email,
> map mỗi org's `login` thành `"org:<login>"`; lỗi gọi API degrade về `Groups` rỗng, không fail login
> (org-level only, ghi chú team-level là follow-up trong comment, không implement). Test:
> `TestGitHubExchangeAndVerify_OrgMembershipPopulatesGroups`,
> `TestGitHubExchangeAndVerify_OrgMembershipFailureDegradesToEmptyGroups` — cùng 4 test cũ của file, cả 6
> đều pass. `go build`/`go test` sạch cho package `oauth`. (Ghi chú: task này được 1 phiên trước đó hoàn
> thành code nhưng bị gián đoạn giữa chừng do rate limit trước khi cập nhật status — verify + đánh dấu
> lại ở đây.)

**Solution:** BE-SOL-003 | **CR:** CR-RBAC-003
**Depends on:** TASK-BE-007 (`VerifiedSsoIdentity.Groups` field must exist first).

---

## Goal

`github.go`'s `SsoExchanger` implementation doesn't call GitHub's org/team membership endpoints — GitHub
logins never populate `Groups`, so group→role mapping (TASK-BE-010) has nothing to match against for
GitHub-authenticated users.

## What to do

In `backend-go/services/auth-service/internal/adapter/oauth/github.go`, after the existing
subject/email resolution: call `GET /user/orgs` (authenticated with the same access token already in hand
from the code exchange) and map each returned org's `login` into `Groups` as `"org:<login>"`.

- Start with **org-level only** — team-level granularity
  (`GET /orgs/{org}/teams/{team}/memberships/{username}`) is a heavier, N+1-shaped call per team. Note it
  as a follow-up in a code comment, don't implement it.
- **Failure handling**: a GitHub API failure for the orgs call must degrade to empty `Groups` (login still
  succeeds), never fail the whole SSO flow — organizational membership is an enhancement, not a login
  precondition.

## Acceptance Criteria

- [x] `github.go`'s exchange flow calls `GET /user/orgs` after subject/email resolution.
- [x] Each org's `login` is mapped into `Groups` as `"org:<login>"`.
- [x] A `GET /user/orgs` failure results in empty `Groups`, not a failed login — verified by test.
- [x] `github_test.go`: org membership call populates `Groups` as `"org:<login>"`; API failure degrades
      gracefully (login still succeeds).
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Reuses the same `VerifiedSsoIdentity` impact numbers as TASK-BE-007 (12 direct callers, all
`auth-service`-internal, LOW risk). No new `impact()` run needed unless `github.go`'s own exchange
function has other callers beyond what TASK-BE-007 already surfaced — verify quickly with
`codegraph_explore("ExchangeAndVerify github.go")` if uncertain.

## Blocking

Blocked on TASK-BE-007. Blocks TASK-BE-010 (GitHub-sourced groups need to exist before role resolution
can match against them, though TASK-BE-010 can also proceed with OIDC-only groups if this task is not yet
done).
