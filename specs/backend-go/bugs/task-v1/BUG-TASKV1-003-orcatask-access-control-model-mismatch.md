# BUG-TASKV1-003: Grant model is Owner/Admin/User/Team/Company (grantee-kind), not the documented view<comment<edit<execute<manage action scale — and team grants still never match

**Business Logic:** [BL-TG-03](../../../../docs/logic/task-graph/BL-TG-03-task-access-control.md) — Task Access Control & Sharing
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/domain/grant.go`
**Priority:** P0
**Status:** PARTIAL
**Severity:** High
**Symptom:** The real permission model implemented is a 5-tier **grantee-kind** scale (`Owner > Admin > User > Team > Company`) that conflates *who* the grant is for with *what* they can do — not the business doc's `view < comment < edit < execute < manage` **action-scope** scale. Any grant scoped to a team can never match any caller (the team-membership resolver is a hardcoded stub). There is no reporter auto-grant on task creation, and no public share-link.

---

## Spec summary

BL-TG-03 defines an ordered 5-tier **action** scale (`view < comment < edit < execute < manage`) and a `hasTaskAccess()` algorithm: owner always wins, admin always wins, then direct/team/company grants on the task itself plus inherited (`apply_tree=true`) ancestor grants, filtered by expiry, resolved to the highest matching permission. It also specifies an automatic "reporter" grant when a task is created, and a public/anonymous share-link flow.

## What backend-go has (confirmed current)

- `GrantLevel` (`backend-go/services/task-service/internal/domain/grant.go:11-19`) is confirmed unchanged: `Owner/Admin/User/Team/Company` — an enum that names *who* a grant targets (a specific user vs. a team vs. a company-wide grant), not an ordered *action* scale. The doc comment at `grant.go:1-9` explicitly states this diverges from the design doc's `grantee_type` (user/team/company) + separate action-level sketch, and that the generated proto (the authoritative wire contract) folds them together.
- `Grant.Matches` (`grant.go:83-96`) confirms the grantee-kind semantics: `Owner/Admin/User` match by user ID, `Team` matches by team membership, `Company` matches by company/tenant ID — there is no `view`/`comment`/`edit`/`execute`/`manage` value anywhere in this type.
- `domain.ResolveGrant` (`grant_resolution.go`) still implements a real, tested ancestor-walk + `apply_tree` inheritance + priority resolution (`priority()` at `grant.go:31-45`: `Owner=0 > Admin=1 > User=2 > Team=3 > Company=4`).
- `StubTeamScopeResolver.ResolveTeams` (`backend-go/services/task-service/internal/adapter/grpcclient/team_scope_resolver.go:24-26`) is confirmed still a stub, wired as-is in production: `backend-go/services/task-service/cmd/server/main.go:86` — `taskgrpcclient.NewStubTeamScopeResolver()`. Since `Grant.Matches`'s `GrantLevelTeam` branch requires `caller.hasTeam(...)` and `caller.TeamIDs` is always empty via this stub, every team-scoped grant remains dead on arrival.

## What's missing (re-confirmed, unchanged since prior audit)

- No `OwnerID` field on `domain.Task` (see BUG-TASKV1-001) — "owner always has full manage" and the spec's reporter-auto-grant-on-create have no schema to sit on; the closest analogue is a `GrantLevelOwner` row, which must be created explicitly, not implied by task creation.
- No revoke, no grant expiry, no public/anonymous share-link, no grant-received notification — none of `Revoke`/`ExpiresAt`/`public_link`/`share_token` exist anywhere in `task-service` (confirmed via the domain/usecase/proto files above; grep for these terms returns zero matches).
- No grant listing on the public API surface — `ListGrantsForAncestors` remains internal-only, consumed solely by `ResolvePermission`.
- `ResolvePermissionRequest` still has no `action` field on the wire — `internal/adapter/grpc/server.go` hardcodes `Action: "read"` for every call.

## See also

- [`logic-v1/BUG-TG-03-task-access-control-partial.md`](../logic-v1/BUG-TG-03-task-access-control-partial.md) — full original audit with complete citations (grant-resolution BFS algorithm, OPA policy evaluation, all absent features); this report only re-confirms it is unchanged.

## References

- `backend-go/services/task-service/internal/domain/grant.go:1-19,31-45,83-96` — model doc comment, `GrantLevel` enum, `priority()`, `Matches`
- `backend-go/services/task-service/internal/adapter/grpcclient/team_scope_resolver.go:11-26` — `StubTeamScopeResolver`, still hardcoded empty
- `backend-go/services/task-service/cmd/server/main.go:86` — stub wired into production composition root
