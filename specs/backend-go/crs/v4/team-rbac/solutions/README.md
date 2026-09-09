# backend-go Solutions — Team RBAC (v4)

**CRs:** [docs/crs/v4/team-rbac/](../../../../../../docs/crs/v4/team-rbac/README.md)

All 8 solutions below are design specs only — **no production code was
changed** while writing them. Each is marked `🔲 Proposed — not implemented`.
Every symbol a solution proposes to edit was checked with `codegraph_explore`/
`gitnexus impact()` in this pass (numbers cited are real tool output, not
carried over unverified from the prior audit — see each solution's own
"Impact analysis" section).

## Solutions

| Solution | CR | Priority | What it actually requires |
|---|---|---|---|
| [BE-SOL-001](./BE-SOL-001-admin-rpc-surface-audit.md) | CR-RBAC-001 | 🔴 P0 (last to execute) | RPC surface audit — confirms 4/5 planned Admin tabs are fully backed already; flags one probable small gap (`ForceRevokeSession`, single-session admin revoke) to verify and close |
| [BE-SOL-002](./BE-SOL-002-caller-role-claim-propagation.md) | CR-RBAC-002 | 🔴 P0 | `callerGlobalRole` reads `tenant.Role(ctx)` instead of hard-coding `""` — **verified the surrounding claim-propagation plumbing (api-gateway → grpcmw → tenant.WithRole) already exists** for the cookie/session path; also adds a `Role` claim to `jwtauth.Claims` so the bearer-JWT path (currently unused in production) doesn't regress once real user-facing token issuance ships |
| [BE-SOL-003](./BE-SOL-003-sso-group-mapping-and-session-refresh.md) | CR-RBAC-003 | 🟡 P1 | SSO group→role mapping (OIDC `groups` claim, GitHub org membership) + a new `RefreshSession` RPC/`POST /auth/refresh` |
| [BE-SOL-004](./BE-SOL-004-team-grant-visibility-verification.md) | CR-RBAC-004 | 🔴 P0 | **Verified already fixed** under a prior bug fix labeled BUG-013 — both wscompat call sites (`devServer.listForUser`, onboarding fan-out) already resolve `TeamIds` via `tenant-service.ListTeamsForUser` and forward them to `infra-fleet-service.ListDevServersForUser`, whose usecase already implements the team-grant branch with test coverage. Only remaining work: a wiring-level regression test and a stale frontend comment |
| [BE-SOL-005](./BE-SOL-005-audit-log-outcome-and-coverage.md) | CR-RBAC-005 | 🟡 P1 | Adds `outcome`/`ip_address` to `AuditEntry` + a new cross-service `AppendAuditEntry` RPC so project/task/annotation/infra-fleet-service can audit their OPA allow/deny decisions (none do today, confirmed) |
| [BE-SOL-006](./BE-SOL-006-opa-policy-publish-and-reload.md) | CR-RBAC-006 | 🟠 P1 | Replaces `NoopPublisher` with a real file-based publisher + a self-invalidating `Evaluator` cache (polls its own bundle path, no cross-service signal needed — **found and corrected a gap in the CR's own Hướng-1(b) framing**: project/task/annotation-service each run their own `Evaluator` in a separate process, so an RPC-based reload signal from auth-service alone wouldn't reach them). Also **found and flagged** that none of the 5 `.rego` files currently consult any `data.*` document at all, so publishing alone doesn't yet change any enforcement outcome — adds one minimal, additive consuming rule as proof-of-effect |
| [BE-SOL-007](./BE-SOL-007-saml-exchanger-preliminary-design.md) | CR-RBAC-007 | ⚪ P3 Backlog | Shallow design only, per the CR's own request for product-owner confirmation before deeper design; flags one real technical finding (SAML's assertion flow doesn't fit the existing `SsoExchanger` interface's OAuth2-code-exchange shape) |
| [BE-SOL-008](./BE-SOL-008-admin-wscompat-channels-policies-sessions-audit-teams.md) | CR-RBAC-001 | 🔴 P0 | **New — closes a gap this pass's own README flagged.** 4 new wscompat files (`channels_admin_{policies,sessions,audit,teams}.go`, 14 channels total) wiring the RPCs BE-SOL-001 confirmed exist to `window.api.admin.*`, the transport the frontend cutover (`AdminOrgConsole.tsx`) actually uses — none of BE-SOL-001..007 designed this; BE-SOL-001 only audited the gRPC-level surface |

## Execution order (from `docs/crs/v4/team-rbac/README.md`'s "Thứ tự thực thi")

```
BE-SOL-002 (role model + claim propagation) ─┐
BE-SOL-004 (server visibility — verified already done) ├─ independent, parallel
BE-SOL-005 (audit schema + coverage)         │
BE-SOL-006 (policy publish)                  ─┘
                    │
                    ▼
BE-SOL-001 (admin RPC surface audit)  ← resolves ForceRevokeSession question
                    │
                    ▼
BE-SOL-008 (admin.* wscompat channels) ← §2.1/§2.3(base)/§2.4 can start as
                    │                     soon as BE-SOL-001 lands (no
                    │                     dependency on its OUTCOME, only on
                    │                     it having run); §2.2's
                    │                     admin.forceRevokeSession channel
                    │                     specifically waits on BE-SOL-001 §3
                    ▼
CR-RBAC-001's frontend cutover (FE-TASK-017..021) — has something to call now
                    │
BE-SOL-003 (SSO group mapping + refresh) ─── depends on BE-SOL-002 (role model final)
                    │
BE-SOL-007 (SAML) ─────────────────────────── Backlog, depends on BE-SOL-003
```

BE-SOL-001 + BE-SOL-008 together are the direct **prerequisite of the
CR-RBAC-001 frontend cutover**: BE-SOL-001's RPC-surface audit confirms what
exists at the gRPC level; BE-SOL-008 is what actually makes it reachable from
the browser (`window.api.admin.*` → wscompat — the transport
`AdminOrgConsole.tsx` uses, not the legacy `/admin/api/*` REST surface).
Until BE-SOL-001's one flagged gap (`ForceRevokeSession`) is verified/closed
and BE-SOL-005/006 have shipped, the Policies and Sessions tabs specifically
would either be wired to inert RPCs (Policies, pre-BE-SOL-006) or missing an
RPC entirely (Sessions' single-revoke action, if BE-SOL-001's gap is
confirmed real) — BE-SOL-008 §5 documents exactly which of its 14 channels
are blocked by which upstream solution and which are not.

## What this pass verified beyond the original CR text

Three findings materially change what implementation work remains, all
confirmed via `codegraph_explore`/`gitnexus impact()` rather than assumed:

1. **CR-RBAC-002's claim-propagation plumbing is mostly already built.**
   `common/tenant.WithRole`/`Role` and `common/grpcmw.MetadataRole` exist,
   are tested, and are wired end-to-end from api-gateway's cookie/session
   auth path through to every service's inbound gRPC interceptor. The actual
   CR-RBAC-002 fix is a 2-line function body change in
   `project-service/internal/usecase/authorization.go`, not new
   infrastructure.
2. **CR-RBAC-004 is already fixed.** The CR's own cited evidence (a frontend
   comment claiming `tenant-service` has no list-teams-for-user RPC) is
   stale — a prior fix (referenced in code as "BUG-013") already wired
   `ListTeamsForUser` into both consuming wscompat channels.
3. **CR-RBAC-006's framing undercounts the gap.** Beyond `NoopPublisher`
   being a stub, (a) `project-service`/`task-service`/`annotation-service`
   each run their own `policy.Evaluator` in separate processes reading the
   same bundle path, so a same-process reload signal wouldn't propagate
   cross-process, and (b) no `.rego` file in the bundle consults any
   `data.*` document today, so even a working publish pipeline changes
   nothing until at least one rule is taught to read it.

## Not covered by this pass

- The `frontend/` and legacy-`backend/` changes CR-RBAC-001/002/004 each
  also list — out of scope for a backend-go-only solution set, tracked in
  each solution's "Out of scope"/"Files to change" as items for whoever
  executes the frontend cutover.
- `task-service`/`annotation-service`'s exact OPA-decision call sites for
  BE-SOL-005's audit wiring — named as verify-before-implementing items in
  that solution rather than guessed at.
- GitHub team-level (vs. org-level) group granularity and Google Workspace
  group mapping — both explicitly deferred in BE-SOL-003.
