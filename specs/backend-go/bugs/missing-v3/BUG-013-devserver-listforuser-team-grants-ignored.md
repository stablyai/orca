# BUG-013: `devServer.listForUser` ignores team-based grants — `team_ids` is always empty

**Status:** PARTIAL — channel is registered and works for department-based grants; silently returns an incomplete list for team-based grants.
**Severity:** Medium

---

## Summary

`devServer.listForUser` — the non-admin RPC a regular user's client calls to
discover which dev servers they're allowed to use — is registered and does
real work, but only resolves **department**-based access grants. **Team**-based
grants (a first-class grantee type the admin-side `devServerGroup.grant`
channel explicitly supports) can never match for any user, because the
handler never populates `team_ids` in its downstream request. The gap is
undocumented to the caller: the RPC succeeds and returns a plausible-looking
(just incomplete) list, with no error and no indication anything is missing.

## What's wired (proof the channel is registered and largely real)

- Registration: `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:285`
  ```go
  r.Register("devServer.listForUser", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
  ```
- The handler is genuinely wired end-to-end for the department path: it
  resolves the caller's department via a real `tenant-service.GetUserProfile`
  call (`channels_dev_server_access_control.go:289`), then calls
  `infra-fleet-service.ListDevServersForUser` (`:297`) and maps real results
  back through `attachConnectionStatus`/`toDevServerView` (`:301-304`).
- The companion admin channel `devServerGroup.grant`
  (`channels_dev_server_access_control.go:217-239`) explicitly supports
  granting a dev-server group to a `"team"` grantee (not just `"department"`)
  — so team-based grants are a real, admin-creatable state in the system.

## What's stubbed/partial

- `channels_dev_server_access_control.go:297` builds the downstream request
  with only `DepartmentId` populated:
  ```go
  resp, err := client.ListDevServersForUser(fleetRpcCtx, &infrafleetv1.ListDevServersForUserRequest{DepartmentId: departmentID})
  ```
  `TeamIds` (the request's other grant-matching field) is never set — there
  is no code path in this handler that populates it.
- The gap is acknowledged directly above the registration, in the handler's
  own doc comment (`channels_dev_server_access_control.go:279-284`):
  > "Known gap: team_ids is always empty here — tenant-service has no 'list
  > teams for user' RPC today (only ListTeams(company_id) and
  > ListTeamMembers(team_id), an N+1 pattern this handler deliberately does
  > not do). Department-based grants work correctly; team-based grants
  > won't match anything until that follow-up RPC exists."
- Corroborated independently by the design doc that introduced this access
  model: `docs/crs/v2/dev-server/CR-DS-007-department-based-access-control.md:84`
  documents `ListDevServersForUser`'s `team_ids` as "luôn rỗng" (always
  empty) as a known implementation gap, not a design choice.
- Root cause: `tenant-service` has no RPC to answer "which teams is this
  user a member of" — only `ListTeams(company_id)` (all teams in a company)
  and `ListTeamMembers(team_id)` (members of one team), which would require
  an N+1 fan-out this handler deliberately avoids.

## What the frontend actually needs

`devServer.listForUser` is called from the non-admin dev-server picker flow
(`frontend/src/renderer/src/components/onboarding/OnboardingFlow.tsx:180`,
`frontend/src/renderer/src/components/onboarding/DevServerStep.tsx:130`) to
show a user every dev server they're allowed to connect to. A user whose
only access grant is a **team** grant (rather than a department grant) will
see an empty or incomplete list with no error — the RPC returns
`{"devServers": [...]}` successfully, just missing entries that should be
there per the access-control model the admin side already implements. This
is silent under-provisioning: there's no signal to the user or an operator
that a grant exists but isn't being honored.

## Fix direction (not evaluated for effort here)

Add a "list teams for user" RPC to `tenant-service` (the gap the code
comment already names) and populate `TeamIds` in the
`ListDevServersForUserRequest` built at `channels_dev_server_access_control.go:297`.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:275-304`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_dev_server_access_control.go:217-239` (devServerGroup.grant supporting "team" grantee)
- `docs/crs/v2/dev-server/CR-DS-007-department-based-access-control.md:84`
- `frontend/src/renderer/src/components/onboarding/OnboardingFlow.tsx:180`
- `frontend/src/renderer/src/components/onboarding/DevServerStep.tsx:130`
