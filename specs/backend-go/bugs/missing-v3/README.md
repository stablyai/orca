# Missing-v3 Bug Reports — `backend-go` vs. frontend RPC surface (2026-09-07)

This directory catalogs every **currently-live** gap where the frontend calls an
RPC method that needs `backend-go` to handle it (when the active runtime target
is a remote/backend-go-backed environment, i.e. `settings.activeRuntimeEnvironmentId`
is set) but `backend-go` doesn't support it at all, or only partially/incorrectly
supports it. This is a fresh, from-scratch pass against today's code — not an
update to `../missing-v1/`, `../missing-v2/`, or `../logic-v1/` — but it
deliberately cross-references all three throughout, since re-deriving already-filed
findings wastes everyone's time (`BUG-007` below is the cautionary example: an
earlier draft of this very pass re-discovered `missing-v1/BUG-009` as if it were
new, before deeper checking showed it's actually resolved).

## Headline numbers

- **304 unique RPC methods** the frontend calls via `callRuntimeRpc(target, '<method>', …)`
  today (`frontend/src/renderer/src/runtime/runtime-rpc-client.ts`), across 38
  namespaces.
- **309 channels** registered in `backend-go`'s `wscompat` layer
  (`backend-go/services/api-gateway/internal/adapter/wscompat/*.go`) — up from
  245 at `../missing-v2/`'s snapshot (2026-09-01) and 8 at `../missing-v1/`'s
  original snapshot (2026-08-17). The backend-go rewrite has closed the vast
  majority of the original gap.
- Of the remaining daylight between those two numbers, most is **not** a real
  gap: ~62 frontend-called methods (`app.*`, `platform.*`, `updater.*`, `shell.*`,
  `ui.*`, `claudeUsage.*`/`codexUsage.*`/`openCodeUsage.*`, `diagnostics.*`) are
  hardcoded to `{kind:'local'}` in the frontend and never reach any backend by
  design, and `orcaProfiles.*`/`mobile.*`/`ephemeralVm.*` are confirmed-desktop-only
  by an authoritative, currently-maintained source of truth (see Methodology).
- **12 real, confirmed gaps filed** (`BUG-004`–`BUG-006`, `BUG-008`–`BUG-015`),
  plus **1 explicit non-finding** (`BUG-007`, kept as a false-positive record) and
  **2 namespaces investigated and confirmed to need no report** (`orcaProfiles.*`,
  `mobile.*` — see below). `BUG-001`–`BUG-003` are intentionally absent: they were
  reserved for exactly those two namespaces during this audit's parallel-agent
  pass, and no report was warranted.

## Methodology

This pass combined three techniques, in this order:

1. **Ground-truth diff.** Regenerated the full frontend RPC call list (regex
   over every `callRuntimeRpc(target, '<method>', …)` call site) and the full
   `wscompat` registered-channel list (regex over every `.Register("<method>"`
   call), then diffed them. This alone is **not reliable** — `backend-go` has
   at least two more registration idioms a literal-string grep misses entirely:
   loop-driven dynamic registration (`for _, op := range [...] { r.Register("browser."+op, ...) }`,
   used by `channels_browser.go`/`channels_browser_profiles.go`) and helper
   wrappers (`simpleFileOp(...)` in `channels_git.go`, `RegisterStreamChannel`/
   `RegisterBinaryStreamHandler` for terminal/binary-stream channels). Every
   finding below was re-verified past this naive diff — `BUG-007` exists
   specifically to document a case where the diff's "unregistered" verdict was
   simply wrong.
2. **Local-vs-remote classification.** Not every method the frontend calls even
   *should* reach a backend. `callRuntimeRpc`'s `target` is either `{kind:'local'}`
   (routes to Electron's own IPC, handled entirely inside the desktop app) or
   `{kind:'environment'}` (routes to `window.api.runtimeEnvironments.call`,
   which reaches backend-go). Each candidate namespace's frontend client file
   was read to confirm it's actually called with a dynamic/environment-capable
   target — not hardcoded local — before being treated as in-scope. The
   authoritative, currently-maintained source for "this is desktop-only, don't
   file a bug for it" is
   `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`'s
   `DESKTOP_ONLY_NAMESPACES` set, cross-referenced against
   `specs/backend/api/desktop-only-rpc-parity-gaps.md` (a prior, thorough
   investigation of the *old* TypeScript `backend/`'s desktop-parity gaps —
   different backend than backend-go, but its per-namespace "does this even
   make sense on a shared server" conclusions transfer directly, and in two
   cases — `orcaProfiles.*`, `mobile.*` — settled this pass's classification
   outright without needing new investigation).
3. **Parallel per-namespace deep-dives.** Once a namespace was confirmed
   in-scope and genuinely gap-shaped, a dedicated pass read the frontend call
   site, the `wscompat` registration (or absence), the candidate owning
   service's `.proto` + `internal/usecase/`, and cross-checked
   `../missing-v1/`, `../missing-v2/`, and `../logic-v1/` for prior coverage
   before writing a report. A separate pass spot-checked *already-registered*
   channels in files not covered by `../logic-v1/`'s 74-flow business-logic
   audit, looking specifically for stub handlers (`return nil, nil`, hardcoded
   responses, TODO comments) that a naive "is it wired?" check would call done.

No solutions/tasks subdirectories were produced for this pass (unlike
`../missing-v1/`/`../missing-v2/`) — this directory is the bug catalog only,
per the request that produced it.

## Bug index

| ID | Title | Severity | Kind |
|----|-------|----------|------|
| [BUG-004](./BUG-004-ephemeralvm-channels-not-implemented.md) | `ephemeralVm.*` (9/9 methods) not implemented — no owning service | Medium | Full gap (capability) |
| [BUG-005](./BUG-005-starnag-channels-not-implemented.md) | `starNag.*` (10/10 methods, +2 streaming) not implemented — proven portable, old backend already has it | Low | Full gap (capability, low-effort) |
| [BUG-006](./BUG-006-speech-models-channels-not-implemented.md) | `speech.models.*` (3/3 methods) — investigated, will not be ported to backend-go; resolved via `DESKTOP_ONLY_NAMESPACES` | Medium | Resolved — will not implement (frontend suppressor) |
| [BUG-007](./BUG-007-files-channels-false-positive-already-implemented.md) | `files.*` — **not a gap**, fully implemented via `simpleFileOp` in `channels_git.go`; pre-screening false positive | N/A | False positive (kept as record) |
| [BUG-008](./BUG-008-terminal-create-host-local-connectionless-unsupported.md) | `terminal.create` fails permanently for connectionless "runtime" environment targets (works for dev-server/SSH-bound targets) | Medium | Partial |
| [BUG-009](./BUG-009-browser-profile-relay-channels-inert.md) | `browser.*` — 7/19 called methods don't work end-to-end: 3 profile-relay ops wired-but-agent-inert, plus `tabShow`/`back`/`forward`/`reload` (found 2026-09-07) unregistered entirely | Medium | Partial (agent-side + unregistered) |
| [BUG-010](./BUG-010-onboarding-preflight-channels-not-implemented.md) | 6/10 `onboarding.*` methods not implemented (host-capability detection, `gh auth login`, git identity) — corrected from "6/9" 2026-09-07 | Medium | Partial namespace |
| [BUG-011](./BUG-011-git-cancel-generate-channels-not-implemented.md) | `git.cancelGenerateCommitMessage`/`cancelGeneratePullRequestFields` not implemented — no cancellation concept exists in backend-go's dispatch model | Low | Full gap (narrow) |
| [BUG-012](./BUG-012-github-starorca-updateprtitle-not-implemented.md) | `github.starOrca`/`updatePRTitle` not implemented — proto RPCs now designed (TASK-034 done, uncommitted) but usecase/wiring (TASK-035/036) still TODO, per 2026-09-07 update | Low-Medium | Full gap (narrow, now in-progress) |
| [BUG-013](./BUG-013-devserver-listforuser-team-grants-ignored.md) | `devServer.listForUser` silently ignores team-based access grants (`team_ids` always empty) | Medium | Partial (silent under-provisioning) |
| [BUG-014](./BUG-014-telemetry-track-no-op.md) | `telemetry.track` registered but a complete no-op — zero product analytics reach any backend | Low | Stub |
| [BUG-015](./BUG-015-files-createfile-watch-browseserverdir-not-implemented.md) | `files.createFile`/`files.watch`/`files.browseServerDir` unregistered — missed by the pre-screening scan's literal-string-only methodology, not covered by `BUG-007` | Medium | Full gap (3 narrow methods) |
| [BUG-015](./BUG-015-workspaceports-scan-kill-argshape-mismatch.md) | `workspacePorts.scan`/`kill` decode `{connectionId, worktreeId}` but the real frontend only ever sends `{repoId}` — every real call silently no-ops (empty scan result / fixed "not implemented" kill reason) | Medium | Partial (arg-shape mismatch, known caveat never closed) |

## Investigated, no report needed

- **`orcaProfiles.*` (16 methods)** — confirmed desktop-only by design, not a
  backend-go gap. It's a Chrome/Firefox-style *local app identity* switcher
  (`switch` relaunches the whole Electron process) plus a PKCE OAuth client to
  an entirely separate Orca Cloud SaaS API — coincidental name collision with
  backend-go's own `profile.*`/tenant-service namespace, not the same concept.
  Already investigated in full at `specs/backend/api/orca-profiles-server-mode-design.md`
  (2026-08-17) with the same conclusion; already in `DESKTOP_ONLY_NAMESPACES`.
- **`mobile.*` (9 methods)** — confirmed desktop-only by design. Every method
  is about pairing a phone to *this specific running process's own LAN
  WebSocket endpoint* — needs the desktop machine's own network
  interfaces/firewall state, which is meaningless for a remote/hosted backend.
  Already in `DESKTOP_ONLY_NAMESPACES`.

## Investigated, found clean (registered channels, real implementation — no new report)

Spot-checked as part of the stub-hunting pass, specifically because these are
newer `wscompat` files not covered by `../logic-v1/`'s business-logic audit:
`channels_auth_directory.go` (real tenant-scoped query), `channels_ai_provider.go`
(real gRPC to a real Vault-backed credential-broker-service — a stale "STUB
NOTICE" code comment there is itself outdated), `channels_jira.go` /
`channels_linear.go` (real HTTP/GraphQL clients, consistent with
`../missing-v1/BUG-015`/`BUG-016`'s "✅ Resolved" status), and
`channels_automation_task.go`'s CRUD paths (the one real stub reachable from
this file — `task.execute`'s complex-orchestration branch — is already tracked
by `../logic-v1/BUG-TG-04-task-agent-execution-partial.md`, not re-filed here).
`channels_nativechat.go`'s `nativeChat.readSession` is presently
non-functional for every real caller (frontend never sends the `connectionId`
the handler requires) but this is an explicitly-tracked interim state per
`../missing-v1/tasks/TASK-108-wscompat-nativechat-channel.md`, not a new
finding.

Second Group-5 pass (this session, 2026-09-07) checked the remaining files
on that group's list not already covered above:
`channels_admin_users.go` (real gRPC to `auth-service`'s CreateUser/ListUsers/
UpdateUserRole/DeactivateUser/ReactivateUser, admin-gated, cross-referenced
against `../logic-v1/BUG-AUTH-04-admin-user-crud-partial.md` — that report's
"unusable admin-created account" finding is about the REST `/admin/api/*`
surface, which this WS channel's own doc comment says it already fixed
independently by accepting an optional caller-supplied password), `channels_credentials.go`
(+ `channels_credentials_e2e_test.go`, which is a real, if `e2e`-build-tag-gated,
cross-service round-trip test against live `scm-integration-service`/
`issue-tracking-service` — not exercised by a normal `go test ./...` run, but
not a fake either), `channels_orca_project_sharing.go`, `channels_session_tabs.go`,
`channels_scm.go` (1075 lines; every `github.*`/`gitlab.*`/`hostedReview.*`
handler delegates to a real `scm-integration-service` RPC — the two
`return nil, nil` sites, `github.checkOrcaStarred` and
`github.project.deleteIssueCommentBySlug`, are both documented, intentional
"no real answer exists"/void-delete cases, not stubs) (+ `channels_scm_work_items_test.go`,
which only unit-tests the `parseGitHubOwnerRepo` URL parser, not the
`github.listWorkItems` channel's end-to-end behavior — a narrow test-coverage
gap, not a functional one), `channels_terminal_multiplex.go`,
`channels_terminal_subscribe.go` (both real, carefully-documented AttachPty
relays), and `channels_emulator_folderworkspace_host.go` (`folderWorkspace.*`
is real CRUD against `project-service`; `emulator.*`/`host.*`'s degraded
"honest unsupported/local-answer" states are pre-existing, deliberate,
already-tracked scope cuts per `missing-v1/solutions/SOL-008-emulator-channels.md`
and `SOL-011-host-channels.md`, not new findings). All found clean except
`channels_repo_ssh_status_workspace.go`'s `workspacePorts.*` pair — see
BUG-015 above. `channels_push.go` was also checked: `notifications.subscribe`
is a real gRPC relay, and `runtime.clientEvents.subscribe`'s `ClientEventBus.Publish`
having no caller anywhere in the codebase (confirmed via
`grep -rn "\.Publish(" services/api-gateway`) is a real, live gap — but it's
already fully tracked as a known, deliberately-deferred follow-up in
`../missing-v1/BUG-035-ws-server-push-not-implemented.md` and
`../missing-v1/tasks/TASK-015-register-clientevents-local-fanout.md` ("no
publisher call site exists yet (correctly deferred as this task's own
follow-up)"), so not re-filed here.

## Cross-cutting observations

- **The "unregistered channel" diff has real false-positive modes.** Two of
  this pass's own draft findings turned out to be wrong on deeper inspection
  (`BUG-007`'s `files.*`, and 9 of the 12 `browser.*` methods folded into
  `BUG-009`) because a literal-string `.Register("...")` grep can't see
  backend-go's loop-driven and helper-wrapped registration idioms. Anyone
  re-running this audit's methodology should grep for `simpleFileOp`,
  `RegisterStreamChannel`, `RegisterBinaryStreamHandler`, and
  `for _, op := range` alongside plain `.Register(` before concluding a
  channel is missing.
- **"Registered" and "works" are different questions, and the gap between them
  is where the interesting partial-support bugs live** — `BUG-008` (registered,
  but hard-fails for one whole class of target), `BUG-009` (registered, but the
  agent has no handler), `BUG-013` (registered and mostly works, but silently
  drops one grant type), `BUG-014` (registered, but the handler is `return nil, nil`).
  None of these would surface from a name-existence check alone.
- **Two namespaces (`ephemeralVm.*`, `starNag.*`) already have a documented
  paper trail from investigating the *same* question against the *old* TS
  backend** (`specs/backend/api/desktop-only-rpc-parity-gaps.md` and its
  companion `ephemeral-vm-server-mode-design.md`). That prior work is directly
  useful here: `starNag.*` was fully ported there, proving it's a legitimate,
  low-effort, server-mode-appropriate feature backend-go simply hasn't caught
  up on yet; `ephemeralVm.*` was investigated and found to need new agent-side
  infra (outbound SSH-client capability) regardless of which backend
  implements it — not a quick wiring win in either codebase.
- **`backend-go`'s remaining gaps skew narrow and long-tail**, not
  namespace-wide the way `../missing-v1/`'s original audit found. Every
  namespace with 15+ methods (`git.*`, `github.*`, `files.*`, `terminal.*`,
  `worktree.*`, `jira.*`, `linear.*`, `browser.*`) is now ≥80% wired; what's
  left is either a handful of specific methods per namespace (`BUG-010`,
  `BUG-011`, `BUG-012`) or namespaces that are small and self-contained to
  begin with (`BUG-004`, `BUG-005`, `BUG-006`).

## What this doesn't cover

- **Not an exhaustive re-audit of every registered channel.** The
  stub-hunting pass sampled newer `wscompat` files not already covered by
  `../logic-v1/`'s 74-flow business-logic audit; it did not re-read all 309
  registered channels end-to-end. `../logic-v1/`'s own 48-partial/20-missing
  findings (68 reports) remain the authoritative source for business-logic-level
  gaps in already-wired channels outside this pass's spot-check scope.
- **No live/runtime verification.** Unlike `../missing-v2/`, every finding
  here is a static source read (frontend call site + backend-go registration +
  usecase implementation), not a reproduced call against a running deployment.
  Each report's evidence is real `file:line` citations, but "the code says X"
  and "X is what happens at runtime" can diverge (see `../missing-v2/README.md`'s
  own caveat about a live, actively-redeployed environment producing different
  results minutes apart).
- **Desktop-local and agent-side gaps outside backend-go's own scope are
  noted but not the focus.** `BUG-009`'s root cause is entirely in
  `agent/src/relay/`, not backend-go — it's included here because backend-go's
  own wiring is what a naive completeness check would flag, and the report
  exists to correctly redirect that flag rather than to audit the agent
  codebase generally.
