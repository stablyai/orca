# backend-go Tasks — Team RBAC (v4)

**Solutions:** [../solutions/](../solutions/README.md) | **CRs:** [docs/crs/v4/team-rbac/](../../../../../../docs/crs/v4/team-rbac/README.md)

> **Update (2026-09-11): all 32/32 backend-go tasks are now ✅ DONE**, executed for real (not just
> designed) across 8 waves + this backlog task — code written, built, and tested at each step, working
> tree only (no commits). This section's original framing ("all 🔲 TODO") is kept below for history.

All 32 tasks below were **🔲 TODO — not implemented** as originally written. None of the 8 solutions this
task set is derived from changed any production code either — every task started from the same
as-yet-unbuilt baseline. Each task is meant to be picked up and executed by an AI agent **in a single
pass**, without re-reading the original solution docs — file paths, function/struct names, and code
sketches are copied near-verbatim from the solution that scoped them.

> **Update:** TASK-BE-029..032 (below) close the "Known gap" this README originally flagged — see that
> section, kept for history, now marked closed.

## Task ↔ Solution ↔ CR ↔ Status

| Task | Solution | CR | Depends on | Status |
|---|---|---|---|---|
| [TASK-BE-001](./TASK-BE-001-verify-force-revoke-session-gap.md) | BE-SOL-001 | CR-RBAC-001 | — (investigation) | ✅ DONE — gap real (khác shape ban đầu) |
| [TASK-BE-002](./TASK-BE-002-implement-force-revoke-session-rpc.md) | BE-SOL-001 | CR-RBAC-001 | TASK-BE-001 | ✅ DONE — implemented (reopened) |
| [TASK-BE-003](./TASK-BE-003-caller-global-role-reads-tenant-role.md) | BE-SOL-002 | CR-RBAC-002 | — | ✅ DONE |
| [TASK-BE-004](./TASK-BE-004-bearer-jwt-role-claim-propagation.md) | BE-SOL-002 | CR-RBAC-002 | — | ✅ DONE |
| [TASK-BE-005](./TASK-BE-005-global-admin-bypass-regression-tests.md) | BE-SOL-002 | CR-RBAC-002 | TASK-BE-003, TASK-BE-004 | ✅ DONE |
| [TASK-BE-006](./TASK-BE-006-update-f32-role-model-doc.md) | BE-SOL-002 | CR-RBAC-002 | TASK-BE-003 | ✅ DONE |
| [TASK-BE-007](./TASK-BE-007-oidc-groups-claim.md) | BE-SOL-003 | CR-RBAC-003 | TASK-BE-003..006 | ✅ DONE |
| [TASK-BE-008](./TASK-BE-008-github-org-membership-groups.md) | BE-SOL-003 | CR-RBAC-003 | TASK-BE-007 | ✅ DONE |
| [TASK-BE-009](./TASK-BE-009-sso-group-role-mapping-table-and-admin-rpcs.md) | BE-SOL-003 | CR-RBAC-003 | TASK-BE-003..006 | ✅ DONE |
| [TASK-BE-010](./TASK-BE-010-resolve-role-from-groups.md) | BE-SOL-003 | CR-RBAC-003 | TASK-BE-007, TASK-BE-009 | ✅ DONE |
| [TASK-BE-011](./TASK-BE-011-session-refresh-domain-and-rpc.md) | BE-SOL-003 | CR-RBAC-003 | TASK-BE-003..006 | ✅ DONE |
| [TASK-BE-012](./TASK-BE-012-auth-refresh-http-route.md) | BE-SOL-003 | CR-RBAC-003 | TASK-BE-011 | ✅ DONE |
| [TASK-BE-013](./TASK-BE-013-devserver-team-grant-wiring-regression-test.md) | BE-SOL-004 | CR-RBAC-004 | — | ✅ DONE |
| [TASK-BE-014](./TASK-BE-014-audit-entry-outcome-ip-schema.md) | BE-SOL-005 | CR-RBAC-005 | — | ✅ DONE |
| [TASK-BE-015](./TASK-BE-015-audit-repository-outcome-filters.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-014 | ✅ DONE |
| [TASK-BE-016](./TASK-BE-016-query-audit-log-filters.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-015 | ✅ DONE |
| [TASK-BE-017](./TASK-BE-017-append-audit-entry-rpc.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-014 | ✅ DONE |
| [TASK-BE-018](./TASK-BE-018-auditclient-shared-package.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-017 | ✅ DONE |
| [TASK-BE-019](./TASK-BE-019-audit-project-service-decisions.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-018 (+ TASK-BE-003 first, same file) | ✅ DONE |
| [TASK-BE-020](./TASK-BE-020-audit-task-service-decisions.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-018 | ✅ DONE |
| [TASK-BE-021](./TASK-BE-021-audit-annotation-service-decisions.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-018 | ✅ DONE |
| [TASK-BE-022](./TASK-BE-022-audit-infra-fleet-connect-decisions.md) | BE-SOL-005 | CR-RBAC-005 | TASK-BE-018 | ✅ DONE |
| [TASK-BE-023](./TASK-BE-023-propagate-client-ip-to-audit.md) | BE-SOL-005 | CR-RBAC-005 | — | ✅ DONE |
| [TASK-BE-024](./TASK-BE-024-evaluator-self-invalidation.md) | BE-SOL-006 | CR-RBAC-006 | — | ✅ DONE |
| [TASK-BE-025](./TASK-BE-025-file-publisher-and-validate-bundle.md) | BE-SOL-006 | CR-RBAC-006 | TASK-BE-024 | ✅ DONE |
| [TASK-BE-026](./TASK-BE-026-admin-rego-data-consuming-rule.md) | BE-SOL-006 | CR-RBAC-006 | — | ✅ DONE |
| [TASK-BE-027](./TASK-BE-027-wire-file-publisher-into-policy-usecases.md) | BE-SOL-006 | CR-RBAC-006 | TASK-BE-025 | ✅ DONE |
| [TASK-BE-028](./TASK-BE-028-saml-design-confirmation-investigation.md) | BE-SOL-007 | CR-RBAC-007 (Backlog, P3) | TASK-BE-009 | ✅ DONE — investigation only, findings re-confirmed |
| [TASK-BE-029](./TASK-BE-029-admin-policy-wscompat-channels.md) | BE-SOL-008 | CR-RBAC-001 | TASK-BE-001/002 | ✅ DONE |
| [TASK-BE-030](./TASK-BE-030-admin-session-wscompat-channels.md) | BE-SOL-008 | CR-RBAC-001 | TASK-BE-002 | ✅ DONE |
| [TASK-BE-031](./TASK-BE-031-admin-audit-wscompat-channel.md) | BE-SOL-008 | CR-RBAC-001 | none (soft: TASK-BE-016) | ✅ DONE |
| [TASK-BE-032](./TASK-BE-032-admin-team-wscompat-channels.md) | BE-SOL-008 | CR-RBAC-001 | none | ✅ DONE — pivoted, see task file |

32 tasks total, spanning all 8 solutions. BE-SOL-004 (1 task) and BE-SOL-007 (1 task) are intentionally
not chunked further, per their own solutions' conclusions (already-fixed verification, and a
Backlog/needs-product-decision item, respectively). BE-SOL-008 (4 tasks, one per new wscompat file) closes
the "Known gap" section below.

## Execution order

Grouped into waves that can run in parallel within each wave, based on the actual file/symbol
dependencies read out of the 7 solutions (not assumed) — cross-checked against
`docs/crs/v4/team-rbac/README.md`'s CR-level "Thứ tự thực thi."

```
Wave 1 (fully independent — start immediately, all in parallel)
  TASK-BE-003  callerGlobalRole fix                     (SOL-002)
  TASK-BE-004  bearer-JWT Role claim                     (SOL-002)
  TASK-BE-013  devServer team-grant regression test       (SOL-004)
  TASK-BE-014  AuditEntry outcome/ip schema               (SOL-005)
  TASK-BE-023  api-gateway client-IP propagation          (SOL-005)
  TASK-BE-024  Evaluator self-invalidation                (SOL-006)
  TASK-BE-026  admin.rego additive rule + opa test        (SOL-006)

Wave 2
  TASK-BE-005  global-admin regression tests   ← needs 003+004
  TASK-BE-006  F32.md role-model doc update    ← needs 003
  TASK-BE-015  audit_repository filters        ← needs 014
  TASK-BE-017  AppendAuditEntry RPC            ← needs 014
  TASK-BE-025  FilePublisher + ValidateBundleAt ← needs 024

Wave 3
  TASK-BE-016  query_audit_log filters         ← needs 015
  TASK-BE-018  common/auditclient package      ← needs 017
  TASK-BE-027  wire FilePublisher into policy usecases + main.go ← needs 025

Wave 4 (the 4 per-service audit wiring tasks — parallel with each other)
  TASK-BE-019  audit project-service decisions   ← needs 018 (land after 003 — same file)
  TASK-BE-020  audit task-service decisions      ← needs 018
  TASK-BE-021  audit annotation-service decisions ← needs 018
  TASK-BE-022  audit infra-fleet-service ssh.connect ← needs 018

Wave 5 (SOL-003 — gated on SOL-002's role model being final, i.e. all of Wave 1/2's SOL-002 tasks done)
  TASK-BE-007  OIDC groups claim                 ← needs 003..006
  TASK-BE-009  sso_group_role_mapping + admin CRUD ← needs 003..006 (parallel with 007)
  TASK-BE-011  session refresh domain + RPC       ← needs 003..006 (parallel with 007/009)

Wave 6
  TASK-BE-008  GitHub org membership groups      ← needs 007
  TASK-BE-010  resolveRoleFromGroups wiring       ← needs 007, 009
  TASK-BE-012  POST /auth/refresh route           ← needs 011

Wave 7 — BE-SOL-001, runs LAST per the CR set's own sequencing (depends on 002/005/006 all landing)
  TASK-BE-001  verify ForceRevokeSession gap      ← after Waves 1-4 (002/005/006) land
  TASK-BE-002  implement ForceRevokeSession RPC   ← needs 001's conclusion

Wave 8 — BE-SOL-008 (new wscompat channels, needed by CR-RBAC-001's frontend cutover)
  TASK-BE-029  admin.*Policy* channels     ← needs 001/002 (audit only, no code gap expected)
  TASK-BE-031  admin.queryAuditLog channel ← none (base version); +follow-up diff once 016 lands
  TASK-BE-032  admin.*Team* channels       ← none
  TASK-BE-030  admin.*Session* channels    ← 2 of 3 channels need only 001/002; admin.forceRevokeSession
                                              hard-blocked on TASK-BE-002's conclusion specifically

Backlog (P3, not scheduled)
  TASK-BE-028  SAML design-confirmation investigation ← needs 009 (schema compatibility check only)
```

## Wave 1 — kết quả thực thi (ngày hôm nay, 2026-09-09)

All 7 Wave-1 tasks (TASK-BE-003/004/013/014/023/024/026) executed in a single pass, in the order they were
originally written up (see each task file's own "Kết quả thực tế" section for full detail):

- **TASK-BE-003** ✅ DONE — `callerGlobalRole` reads `tenant.Role(ctx)`.
- **TASK-BE-004** ✅ DONE — bearer-JWT path now propagates `Role` via `jwtauth.Claims`.
- **TASK-BE-013** ✅ DONE — the wiring-level regression test this task asked for was found to already
  exist (`TestDevServerListForUserChannel_ResolvesDepartmentThenLists`); added the fail-closed-is-deliberate
  comments + the F32 doc scoping-axis note instead of a duplicate test.
- **TASK-BE-014** ✅ DONE — `AuditEntry` gained `Outcome`/`IPAddress`, migration `0004` added, all 10
  in-repo `NewAuditEntry` call sites updated.
- **TASK-BE-023** ✅ DONE — client IP propagated via `tenant.WithClientIP`/`ClientIP` + a new
  `grpcmw.MetadataClientIP` key, read back ambiently by `AttachIdentity` (no per-call-site changes needed).
- **TASK-BE-024** ✅ DONE — `Evaluator` self-invalidates its prepared-query cache (`checkPeriod`, default
  2s; `SetCheckPeriod(0)` rollback path).
- **TASK-BE-026** ✅ DONE — `admin.rego` gained the additive `admin_override` clause + 3 new `opa test`
  cases (38/38 pass).

**Build/test verification:** `go build` clean across every `backend-go` module (looped over each
`go.work`-listed module, since the repo root has no single `./...` target); `go test ./...` clean for
every touched module (`common/tenant`, `common/grpcmw`, `common/policy`, `project-service`, `auth-service`,
`api-gateway`, `annotation-service`, `task-service`, `infra-fleet-service`); `opa test
backend-go/policy/orca-authz` 38/38 pass; `gofmt -l` clean on every changed `.go` file.

**`detect_changes({scope:"compare", base_ref:"main"})` result:** risk **low**, 115 changed symbols across
70 changed files, **0 affected execution flows** (`affected_count: 0`, `affected_processes: []`). Note the
70-file/115-symbol count includes a substantial amount of unrelated, pre-existing uncommitted work already
in this working tree before this session started (`automation-service` REST routes, `ephemeral-vm` CR
docs, several `frontend/` files) — none of that was touched by this session; the actual Wave-1 diff is the
~29 backend-go files listed across the 7 task files' own "Files modified" headers above (2 of which are new
migration files, so not "changed" in git-diff terms). `git status` after this session confirms no file
outside that list plus this README/the 7 task files themselves changed as a result of this work.

Notes on the dependency reasoning:

- **TASK-BE-003/004/013/014/023/024/026 are the true wave-1 set** — each touches a disjoint file/symbol
  with no other in-flight task in this set, verified against each solution's own "Files to change" table.
- **TASK-BE-019 shares a file with TASK-BE-003** (`project-service/internal/usecase/authorization.go`) —
  not a hard dependency (different functions' bodies: `callerGlobalRole` vs. the `requireProjectAccess`/
  `requireRepoAccess` call sites), but sequencing TASK-BE-003 first avoids a needless merge conflict.
- **SOL-006's OPA-rule task (TASK-BE-026) does not need SOL-005's audit schema** — the two are unrelated
  data paths (Rego data documents vs. audit log rows); they were confirmed independent by reading both
  solutions in full, not assumed from the CRs' shared "P1" priority label.
- **SOL-001 running last is the CR set's own explicit instruction**, re-confirmed by reading
  `docs/crs/v4/team-rbac/README.md`'s "Thứ tự thực thi" diagram and BE-SOL-001 §8 — both agree BE-SOL-001
  depends on 002/005/006, not the other way around.

## Wave 2 — kết quả thực thi (ngày hôm nay, 2026-09-09)

All 5 Wave-2 tasks (TASK-BE-005/006/015/017/025) executed in a single pass — see each task file's own
"Kết quả thực tế" section for full detail:

- **TASK-BE-005** ✅ DONE — 4 new tests in
  `project-service/internal/usecase/authorization_test.go`, wired against the REAL
  `opaclient.Client`/`common/policy.Evaluator` (checked-in bundle), not a Go-reimplementation fake.
- **TASK-BE-006** ✅ DONE — `docs/features/F32-team-rbac.md`'s `### Roles` section (untouched by
  TASK-BE-013) now carries a callout stating the real 2-tier global / 3-tier repo-scoped split.
- **TASK-BE-015** ✅ DONE — `AuditRepository.Query` gained `actor_id`/`action`/`outcome` filters; found and
  fixed a real pre-existing bug along the way (`ip_address::text` returned a spurious `/32` CIDR suffix —
  switched to `host(ip_address)`).
- **TASK-BE-017** ✅ DONE — new `AppendAuditEntry` RPC (`auth.proto` + usecase + `server.go`/`main.go`
  wiring), no admin gate, per spec.
- **TASK-BE-025** ✅ DONE — `Evaluator.ValidateBundleAt` (additive, doesn't touch cached state) +
  `FilePublisher` (validate-JSON → validate-compile-via-temp-copy → atomic write), `NoopPublisher` left
  unmodified.

**Build/test verification:** `go build ./...` and `go test ./...` clean for every touched module
(`common/policy`, `project-service`, `auth-service`) plus a sanity `go build ./...` pass on
`task-service`/`annotation-service`/`api-gateway` (unaffected consumers of the touched shared
packages/proto). Integration tests (`-tags=integration`, real dockerized Postgres via testcontainers-go)
for the new `audit_repository_test.go` pass (3/3). `gofmt -l` clean on every changed `.go` file.

**`detect_changes({scope:"compare", base_ref:"main", repo:"orca"})` result:** `risk_level: "medium"`,
`changed_count: 618` changed symbols across `changed_files: 112`, `affected_count: 4` execution flows — all
4 are `auth-service/cmd/server/main.go`'s `run` process (`Run → IntEnv`, `Run → Base`, listed twice under
different process ids), expected from this wave's `main.go` wiring change (TASK-BE-017's
`appendAuditEntryUC`).

Two important caveats on this number, both **carried over from Wave 1's own note**, now more pronounced:

1. **The indexed baseline is stale and on the wrong branch.** `.gitnexus/meta.json` shows
   `indexedAt: 2026-09-08T10:33` (about a day old) on `branch: feature/project-delete-ui` — not this
   session's checked-out `feat/team-rbac-implementation`. `detect_changes` maps git-diff hunks against
   whatever the index already knows, so a large share of the 618/112 figures is the same unrelated,
   pre-existing uncommitted work Wave 1 already flagged (`agent/`, `frontend/`, `ephemeral-vm` CR docs,
   etc.) — not new in this session.
2. **This session's own brand-new symbols/files are absent from the diff, not merely "unaffected."**
   Spot-checked: `AppendAuditEntry` (usecase, RPC handler), `FilePublisher`/`ValidateBundleAt`/`copyDir`/
   `atomicWriteFile`, and every new `_test.go` file added this pass (`authorization_test.go`,
   `append_audit_entry_test.go`, `audit_repository_test.go`, `publisher_test.go`) do not appear anywhere in
   the 3,770-line result — only the pre-existing symbols in the same files they were added to/near
   (`Repository.Append`/`Repository.Query`, `policypublisher.New`/`NoopPublisher`) show as `"touched"`. This
   is the stale index simply not knowing these symbols exist yet, not a signal that they're risk-free — the
   real safety net for this session's changes is the `go build`/`go test`/`gofmt` verification above, run
   directly against the working tree, not through the graph.

`git status` after this session confirms no file outside the 5 Wave-2 task's own files (listed in each task
file's "Kết quả thực tế") plus this README/the 5 task files themselves changed as a result of this work.

## Wave 3 — kết quả thực thi (ngày hôm nay, 2026-09-09)

All 3 Wave-3 tasks (TASK-BE-016/018/027) executed in a single pass — see each task file's own "Kết quả
thực tế" section for full detail:

- **TASK-BE-016** ✅ DONE — `QueryAuditLogInput` gained `ActorID`/`Action`/`Outcome`, threaded through the
  RPC/proto (`QueryAuditLogRequest`, `AuditEntry.outcome`/`ip_address`) into the repository filters
  TASK-BE-015 already added; new table-driven filter-combination test.
- **TASK-BE-018** ✅ DONE — new `common/auditclient` package (`Client`/`New`/`Append`), best-effort by
  construction (`Append` has no error return at all); `common/go.mod` gained its first-ever proto
  dependency (`require` + local `replace`).
- **TASK-BE-027** ✅ DONE — `FilePublisher` wired into `main.go` in place of `NoopPublisher`, gated by a
  new `OPA_POLICY_PUBLISH_DISABLED` rollback toggle; **decided create AND delete should both publish**
  (delete via a same-kind/name emptied-document "retraction," since `PolicyDataPublisher` has no dedicated
  unpublish method) — see the task file's own decision writeup. Required integration test
  (`CreateAccessPolicy`/`UpdateAccessPolicy` → real `FilePublisher` → real `Evaluator.Decision`, no
  restart) added and passing. **Surfaced but did not fix** (out of scope): `admin.rego`'s TASK-BE-026
  `data.orca.authz.admin_override.extra_admins` clause is very likely unreachable through
  `common/policy.Evaluator`'s actual plain (non-bundle) `rego.Load` — empirically, a JSON file at
  `<bundlePath>/data/<kind>/<name>.json` resolves to `data.data.<kind>` (directory-merge only, filename
  dropped, extra "data" segment from the literal `data/` folder), not `data.orca.authz.<kind>.<name>`.
  Flagged in the task file for whoever revisits that clause or `FilePublisher`'s path scheme next.

**Build/test verification:** `go build ./...` and `go test ./...` clean for every touched module
(`common` — including the new `auditclient` package, `auth-service`). Sanity `go build ./...` also
re-confirmed clean for `api-gateway` (unaffected consumer of the touched proto). `gofmt -l` clean on every
changed `.go` file.

**`detect_changes({scope:"compare", base_ref:"main", repo:"orca"})` result:** `risk_level: "high"`,
`changed_count: 1022` changed symbols across `changed_files: 128`, `affected_count: 6` execution flows —
all 6 are `run` → `IntEnv`/`Base` config-loading processes across several services' `cmd/server/main.go`
(`Run → IntEnv` / `Run → Base`, each listed under 3 different process ids), consistent with this wave's own
`main.go`/`config.go` change (the new `DisablePolicyPublish` config field) plus other services' unrelated
concurrent config changes already in the working tree.

Same two caveats as Wave 1/2, more pronounced given how much more concurrent work has landed in the
working tree since:

1. **Stale/wrong-branch index, unchanged from Wave 2**: `.gitnexus/meta.json` still shows
   `indexedAt: 2026-09-08T10:33` on `branch: feature/project-delete-ui`. The 1022/128 figures are
   overwhelmingly the SAME whole-working-tree diff against `main` every wave has reported against — by
   this point the repo has substantial concurrent, unrelated in-flight work from other sessions (SSH
   target port-forwards, CLI-token issuance/revocation, terraform runner, usage-service MySQL migration,
   etc.), not new risk introduced by this wave's 3 tasks specifically.
2. **This wave's own new symbols are absent from the diff, not merely "unaffected"**: spot-checked
   `auditclient`/`Client`/`Append`, and the new integration test
   `TestUpdateAccessPolicy_PublishedChange_VisibleToLiveEvaluator_NoRestart` — none appear anywhere in the
   6,227-line result. As with prior waves, this is the stale index not knowing these symbols exist yet, not
   a signal they're risk-free; `go build`/`go test`/`gofmt` run directly against the working tree (above)
   is this wave's real verification.

`git status` after this session confirms no file outside this wave's 3 tasks' own files (listed in each
task file's "Kết quả thực tế") plus this README/the 3 task files themselves changed as a result of this
work — cross-checked against the full `git status --porcelain` diff, which also shows a large number of
OTHER already-modified/untracked files from concurrent, unrelated sessions (CLI-token usecases,
`infrafleet.proto`, `usage-service` MySQL adapter, etc.) that this wave's work did not touch.

**Note on concurrent editing:** a second, unrelated in-flight session (CR-CLI-002, adding
`IsServiceTokenRevoked`/`ListCliTokens`/`RevokeCliToken`) was actively editing `auth.proto`,
`server.go`, and `cmd/server/main.go` — the exact same 3 files this wave's TASK-BE-016/027 needed to
edit — throughout this session. Handled by re-reading each file's current on-disk state immediately before
every edit (never trusting a stale Read) and using narrow `old_string` anchors scoped to only this wave's
own lines; verified after every edit that the other session's own additions were left intact and the whole
module still built. See TASK-BE-016/027's own "Kết quả thực tế" sections for the specific instances.

## Known gap: this task set does NOT cover CR-RBAC-001's frontend wscompat wiring — ✅ CLOSED

> **Closed.** This section originally flagged a real gap; it now has a solution and 4 tasks. Kept
> verbatim below for history.

CR-RBAC-001's frontend Admin SPA cutover (`AdminOrgConsole.tsx` gaining Policies/Sessions/Audit/Teams
tabs) needs a concrete transport to reach the relevant backend-go RPCs from the Electron renderer.
**BE-SOL-001, as written, only audits the RPC surface** (confirms which gRPC methods exist on
`AuthServiceServer`/`TenantServiceServer`) — it does **not** design or scope new `wscompat` channels
(the `api-gateway/internal/adapter/wscompat/channels_*.go` pattern used elsewhere, e.g.
`channels_workflow.go`) for these 4 new tabs. Whether `AdminOrgConsole.tsx` reaches these RPCs via
existing wscompat channels, new ones, or a different transport entirely was not resolved by any of the 7
backend-go solutions in this set.

This is a **real gap between BE-SOL-001 and the frontend cutover's actual needs**, surfaced from the
frontend side of this work (not itself audited in this backend-go-only task set). Per this task set's own
instructions, that gap is recorded here rather than silently patched by expanding TASK-BE-001/002's scope
— whoever picks up CR-RBAC-001's frontend cutover needs a dedicated wscompat-wiring task (mirroring the
shape of the `v3/project-workspace` set's `TASK-BE-001-workflow-wscompat-wiring-and-tests.md`) once the
exact channel list is known, most likely written as part of the frontend cutover's own task breakdown
rather than added here.

**Resolution:** [BE-SOL-008](../solutions/BE-SOL-008-admin-wscompat-channels-policies-sessions-audit-teams.md)
+ TASK-BE-029..032 (Wave 8, above) now design and task-break exactly this — 4 new `channels_admin_*.go`
files, 14 channels total, following `channels_admin_users.go`'s established pattern.

## Other things intentionally not in this task set

- CR-RBAC-001's actual frontend changes (`AdminOrgConsole.tsx` tabs, retiring `AdminApp`/legacy
  `backend/src/main/admin/*`/`backend/src/main/team/*`) — `frontend/`/legacy scope, out of a
  backend-go-only task set, per BE-SOL-001 §5.
- Historical SQLite data migration (`orca_access_policies`, `orca_teams`, `orca_audit_log`) — a business
  decision, not scheduled here; see CR-RBAC-001's "Không thuộc phạm vi."
- GitHub team-level (vs. org-level) group granularity, Google Workspace Directory API group mapping — both
  explicitly deferred in BE-SOL-003 §4, not tasked here.
- Full resource×action Rego coverage for admin-authored policy data (TASK-BE-026 is a single
  proof-of-concept clause, not the full matrix) — explicitly out of scope per BE-SOL-006 §4.
