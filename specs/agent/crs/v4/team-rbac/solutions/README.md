# Agent Solutions — Team RBAC (v4)

**CRs:** [docs/crs/v4/team-rbac/](../../../../../../docs/crs/v4/team-rbac/README.md) — CR-RBAC-001 through CR-RBAC-007
**backend-go counterpart:** these 7 CRs are, in their entirety, `backend-go` (`auth-service`, `project-service`,
`tenant-service`, `infra-fleet-service`, `api-gateway`) + `frontend` work — see each CR's own "Changes
Required" table.
**Agent counterpart:** none needed — see verdict below.

## Verdict: no agent-side change required for any of the 7 CRs

| CR | Title | Agent change? | Why |
|----|-------|:---:|-----|
| [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md) | Consolidate the two parallel Admin UIs onto backend-go | **No** | Pure `frontend` (`AdminOrgConsole.tsx`, `admin/*`) + legacy `backend/src/main/admin/*` cutover. `agent/` has no Admin UI, no admin API client, and is not part of either "System A" (backend-go) or "System B" (legacy `backend/`) this CR reconciles. |
| [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md) | Unify role model + fix `callerGlobalRole` claim propagation | **No** | All changes are in `api-gateway`'s bearer-JWT middleware, `common/tenant/tenant.go`, `project-service`'s `authorization.go`, and frontend role UI. Confirmed (see §Evidence) that `agent/src/relay/agent-rpc-dispatch.ts`'s dispatch path carries no `RpcExecutionContext`/role/tenant claim of any kind — the agent's own inbound auth is a separate bearer-token handshake, untouched by this CR. |
| [CR-RBAC-003](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-003-sso-group-role-mapping-and-token-refresh.md) | SSO group→role mapping + Orca session token refresh | **No** | The agent process never participates in the SSO/user-login flow (OIDC/GitHub/session refresh) at all. Confirmed the agent's own auth to `infra-fleet-service` is a distinct `agent.handshake` bearer-token exchange (§Evidence) carrying no SSO-derived field (no groups, no session, no user identity). |
| [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md) | Team/Department-scoped dev-server visibility (`ListDevServersForUser` team-grant gap) | **No** | Confirmed the agent's `agent.handshake` payload carries only `agentToken, devServerId, platform, arch, nodeVersion, agentVersion, capabilities` — no `teamId`/`departmentId`/`projectId` field the agent itself reports. Visibility scoping (Department/Team grants) is entirely admin-assigned, post-connection, inside `infra-fleet-service`/`tenant-service`; the agent has no say in and no data contributing to who gets to see it. |
| [CR-RBAC-005](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-005-audit-log-outcome-and-coverage.md) | Audit log `outcome`/`ip_address` + coverage across services | **No** | `agent/src/` contains zero audit-log emission code (§Evidence — the only 4 files matching `audit` are doc-comments citing an unrelated `specs/agent/api/compliance-audit-2026-08-15.md` report, not logging calls). The CR's new `audit.Append`/`AppendAuditEntry` calls all live at the OPA-decision call site inside `project-service`/`task-service`/`annotation-service`/`infra-fleet-service`, upstream of anything reaching the agent's relay connection. The agent never decides allow/deny and never writes an audit row. |
| [CR-RBAC-006](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-006-live-policy-publish.md) | Wire `AccessPolicy` CRUD to a live OPA bundle (retire `NoopPublisher`) | **No** | The agent has no OPA/Rego integration of any kind — it never evaluates policy. `Evaluator`/`PolicyDataPublisher`/`NoopPublisher` are exclusively `auth-service` (Go) constructs; no symbol or concept from this CR exists on the agent side. |
| [CR-RBAC-007](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-007-saml-support.md) | Add SAML as a third `SsoExchanger` (backlog) | **No** | Same reasoning as CR-RBAC-003: the agent is not an SSO/IdP actor. A SAML ACS endpoint would live in `api-gateway`; the new `SsoExchanger` implementation would live in `auth-service`. No agent-side surface is implied by adding a third login method. |

**Net result:** none of the 7 CRs in this batch require a `specs/agent/crs/v4/team-rbac/solutions/SOL-AG-RBAC-NNN.md` design
document, because none of them touch code that runs in the dev-server agent process. This README
documents the verification trail so a future reader does not need to re-derive it. No `SOL-AG-RBAC-*.md`
files were created in this pass — creating one would mean inventing agent work that CRs 001–007 do not
call for.

## Why the agent is structurally out of scope for this CR batch

The dev-server agent (`agent/` — Node.js, TypeScript, `agent/src/relay/*`) is a process that runs on a
developer's remote/dev machine and exposes an RPC surface (git, fs, exec, PTY, AI-agent-spawn, browser,
etc.) to `infra-fleet-service` over one persistent WebSocket connection. All 7 CRs in this batch are about
**who is allowed to ask for something and what gets recorded when they do** — i.e. authentication,
authorization, and audit **decisions**. Those decisions are made entirely in `backend-go` (`auth-service`
for identity/SSO/sessions/policy documents, `project-service`/`task-service`/`annotation-service` for
OPA/Rego enforcement, `infra-fleet-service`/`tenant-service` for dev-server visibility scoping,
`api-gateway` for claim propagation at the HTTP edge) **before** a request is ever relayed to an agent.
By the time an RPC reaches the agent's `agent-rpc-dispatch.ts`, the authorization question has already
been answered upstream — the agent just executes the already-authorized operation (`git.status`,
`fs.readFile`, `agent.exec`, …). This is a structural property of the architecture, not an oversight:
none of the 7 CRs propose changing that boundary.

The one thing the agent *is* an actor in — authenticating itself to `infra-fleet-service` — is a
completely separate, machine-credential mechanism (`agentToken`, opaque bearer token minted at dev-server
registration, hashed and matched by `agentwsserver.Registry.Consume`) that none of these 7 CRs touch or
propose changing.

## Evidence (verified this pass via GitNexus/CodeGraph, 2026-09-09)

### 1. `agent/src/shared/rbac-types.ts` is dead code inside `agent/` (relevant background, not itself part of any CR)

`agent/src/shared/rbac-types.ts` defines `OrcaIdentityProvider`, `OrcaSsoConfig`, `OrcaUser`,
`OrcaAccessPolicy`, `ScopedPairingToken`, and `resolveUserPermissions()` — a byte-for-byte copy of the
same file that also exists at `frontend/src/shared/rbac-types.ts`, `backend/src/shared/rbac-types.ts`, and
`desktop/src/shared/rbac-types.ts` (this is Phase-1 vendor code from the original TS-Electron
`CR-006-team-rbac.md`, pre-dating the backend-go/OPA architecture).

`mcp__codegraph__codegraph_explore` blast-radius results confirm, for each copy:

- `agent/src/shared/rbac-types.ts`'s `OrcaUser` and `resolveUserPermissions` — **2 callers, both inside
  `agent/src/shared/rbac-types.ts` itself** (i.e. the type/function only references itself; nothing else
  in `agent/src/` imports this file).
- `frontend/src/shared/rbac-types.ts`'s copy — same: 2 self-only callers, also dead.
- `backend/src/shared/rbac-types.ts`'s copy — **20 real callers** across `PermissionService.ts`,
  `device-registry.ts`, `profile-rpc-handler.ts`, `team-rpc-handler.ts`, etc. — this is legacy `backend/`'s
  "System B" that CR-RBAC-001 retires.
- `desktop/src/shared/rbac-types.ts`'s copy — **14 real callers** in `desktop/src/main/auth/*`,
  `desktop/src/main/profile/*`, `desktop/src/main/project/*` — the desktop-app equivalent of System B.

So the type is legitimately alive in `backend/` and `desktop/` (both are System B, in scope for
CR-RBAC-001's frontend/legacy-backend cutover — but that CR's own "Changes Required" table does not
list `agent/`, `backend/src/shared/rbac-types.ts`, or `desktop/src/shared/rbac-types.ts` as
touch points, since it only retires the *handlers*, not this shared type file). In `agent/`
specifically it has **zero** external callers — a leftover vendored copy nobody in `agent/` ever needed.

**Recommendation (secondary, opportunistic — not required by any of the 7 CRs):** delete
`agent/src/shared/rbac-types.ts` as dead-code cleanup, independent of this CR batch's implementation
order. Run `impact({target: "resolveUserPermissions", direction: "upstream", file_path:
"agent/src/shared/rbac-types.ts"})` and `impact({target: "OrcaUser", direction: "upstream", file_path:
"agent/src/shared/rbac-types.ts"})` immediately before deleting, per the repo's mandatory-impact-check
rule, to reconfirm zero callers at delete time (results may have changed since this pass).

### 2. The agent's real inbound-auth mechanism is a bearer `agentToken` handshake, not SSO/RBAC

`backend-go/services/infra-fleet-service/internal/adapter/agentwsserver/server.go` (`Server.
handleConnection`) is the receiving side of the agent's `direct-websocket` connection. The agent's first
frame must be a JSON-RPC `agent.handshake` request; its params (`inboundHandshakeParams`) are exactly:

```go
type inboundHandshakeParams struct {
    AgentToken   string   `json:"agentToken"`
    DevServerID  string   `json:"devServerId"`
    Platform     string   `json:"platform"`
    Arch         string   `json:"arch"`
    NodeVersion  string   `json:"nodeVersion"`
    AgentVersion string   `json:"agentVersion"`
    Capabilities []string `json:"capabilities"`
}
```

`s.Registry.Consume(params.AgentToken)` looks up and burns a pre-issued, hashed, opaque bearer token to
resolve a `devServerID` — there is no user, session, role, team, department, or SSO-derived field
anywhere in this exchange. This is the dev-server's own machine credential (minted once at dev-server
registration/onboarding), structurally unrelated to the end-user identity/session/role machinery that
CR-RBAC-002/003/007 change. This directly confirms the "no agent-side field to add" conclusion for
CR-RBAC-003, CR-RBAC-004, and CR-RBAC-007.

### 3. `agent/src/relay/agent-rpc-dispatch.ts` carries no role/tenant claim

`createRpcDispatcher`'s `dispatch()` (the function that runs every inbound RPC once the handshake above
has completed) takes only `(ws, state, rpc: JsonRpcRequest)` — no execution-context object carrying
`userId`/`role`/`tenantId` is threaded through it. (An identically-named `RpcDispatcher`/`dispatch` exists
in `desktop/src/main/runtime/rpc/dispatcher.ts` and does carry an optional `userId` — but that is the
**desktop Electron app's own local IPC dispatcher**, a different class in a different package, not the
dev-server agent.) This confirms CR-RBAC-002's `callerGlobalRole`/`tenant.WithRole` claim-propagation work
is confined to `api-gateway` → `project-service`'s in-process Go context and never crosses into any agent
RPC parameter.

### 4. No audit-log emission code exists in `agent/src/`

`grep -rniE "\baudit\b" agent/src --include="*.ts" -l` matches exactly 4 files
(`agent-preflight-handler.ts`, `agent-git-clone-handler.ts`, `agent-print-mode-exec.ts`,
`fs-agent-directory-browse.ts`), and in every case the match is a comment citing
`specs/agent/api/compliance-audit-2026-08-15.md` (an unrelated API-surface documentation audit) or
`gaps-and-findings.md` — none is a call to any logging/audit function. This confirms CR-RBAC-005's new
`audit.Append`/`AppendAuditEntry` call sites (proposed for `project-service`, `task-service`,
`annotation-service`, `infra-fleet-service`) have no agent-side counterpart to add.

### 5. `PairingOffer` (`agent/src/shared/pairing.ts`) is an unrelated, unrelated-in-purpose, live feature — not to be confused with the dead `ScopedPairingToken`

`agent/src/shared/pairing.ts`'s `PairingOffer` (`{v, endpoint, deviceToken, publicKeyB64, scope}`,
32 real callers, multiple test files) is the **desktop-to-mobile-companion QR-pairing** mechanism
(E2EE key exchange for the Orca Mobile app) — a real, actively used, unrelated feature. It is not the same
concept as `rbac-types.ts`'s dead `ScopedPairingToken` type despite the similar name; there is no
confusion or overlap to resolve as part of this CR batch.

## Method

Read all 7 CR files plus `docs/crs/v4/team-rbac/README.md`, and
`specs/agent/tdd/v5/00-index.md` + `01-architecture.md` (including its "Addendum B" corrections, which
already establish that several TDD-v5 architecture claims — e.g. an agent-side "Health Reporter" push
loop — do not exist in the real, current `agent/src/`, a caution this pass took seriously before trusting
any other TDD claim). Then, for each CR's specific mechanism, ran targeted `codegraph_explore` /
`gitnexus impact` queries against the real `agent/src/` and `backend-go/` source (not assumption) — see
§Evidence above for each query and its result. No agent/src file was modified; only this README was
written, per the task's file-scope constraint.
