# Missing-v3 Tasks — Executable Breakdown of the Solutions

37 task files (`TASK-001`–`TASK-042`, with gaps at 026/037/038 left as
unused headroom by the agents that authored adjacent ranges — not missing
work), derived from the 10 proposals in [`../solutions/`](../solutions/).
Format follows [`../../missing-v2/tasks/`](../../missing-v2/tasks/) (itself
following [`../../missing-v1/tasks/`](../../missing-v1/tasks/)): **From
Solution** / **Priority** / **Service** / **File** / **Depends on** /
**Status**, a Context section, a "Changes to make" section with real code
grounded in the actual current `backend-go`/`agent`/`frontend` source, and a
"Verify" section with exact commands.

> **Status (updated 2026-09-07, execution pass): 32/39 tasks `[x]` DONE,
> 1 `[partial]`, 6 left `[ ] TODO` deliberately.** Every task file's own
> `**Status:**` line is authoritative — this banner aggregates it. All
> `backend-go` services build/vet/test clean together as of this update
> (`go build ./services/<x>/...` for all 17 services, run after every
> parallel task landed); touched `frontend`/`agent` files typecheck clean.
> Not committed — this is real, working-tree code the user should review
> before committing.
>
> **The 6 left `[ ] TODO` are all deliberate, not oversights**:
> `TASK-006` (ephemeralVm ssh-connection-type lifecycle) and `TASK-022`
> (terminal.create's environmentId→devServerId resolution) are genuinely
> blocked on new `agent/` capability / an unbuilt binding model that no
> task in this set was scoped to invent; `TASK-030` (onboarding's
> `openGhAuthTerminal`) stayed blocked because its prerequisite chain
> (`TASK-022`) is itself blocked; `TASK-016`/`TASK-017`/`TASK-018`
> (telemetry implementation) are blocked on a **human product decision**
> — see [`../decisions/DECISION-telemetry-consent-identity-model.md`](../decisions/DECISION-telemetry-consent-identity-model.md),
> written by `TASK-015`, 4 concrete questions, currently `🔴 UNDECIDED`.
>
> **`TASK-025`** (browser-profile cookie import — flagged in advance as
> the highest-risk task in this set) is `[partial]`: the safe, testable
> primitives (macOS Keychain / Windows DPAPI / Linux keyring decryption,
> cookie validation, timestamp conversion, CLI arg-building) are ported
> and unit-tested, but the full live orchestration (real Chromium/Firefox
> SQLite reads, the actual import write-loop) was deliberately left
> unwired rather than shipped untested against real browser data — see
> the task file's own Status note.
>
> **Two genuinely new bugs were found during execution** (deep-dive
> verification surfaced them; neither was in the original 12-bug catalog
> this `tasks/` directory was derived from) — filed as
> [`../BUG-015-files-createfile-watch-browseserverdir-not-implemented.md`](../BUG-015-files-createfile-watch-browseserverdir-not-implemented.md)
> and [`../BUG-016-workspaceports-scan-kill-argshape-mismatch.md`](../BUG-016-workspaceports-scan-kill-argshape-mismatch.md).
> Neither has a `SOL-XXX`/`TASK-XXX` yet — out of scope for this pass,
> flagged for a follow-up round.

## A note on rigor: several tasks correct their own source solution

Every task was written by first reading the **real current source** the
task touches — not by transcribing its `SOL-XXX.md`'s sketch. Several
solutions' sketches turned out to be approximately-right rather than
byte-exact once checked against real code, and the affected tasks say so
explicitly rather than silently reproducing the error:

- **TASK-004** (ephemeral VM lifecycle relay): the real desktop source
  shows `attachWorkspace` is pure Postgres bookkeeping, not a shell-exec of
  the recipe's `create` command as SOL-004 assumed.
- **TASK-011/012** (starNag proto): the real `notification.proto` field is
  `payload_json`, not `body` as SOL-005 guessed.
- **TASK-033** (git AI-completer cancellation): SOL-011 assumed
  `AICompleter` makes a raw HTTP call that might not propagate `ctx`; the
  real code relays via gRPC and already propagates it correctly — the
  actual open question is agent-side, out of scope for backend-go.
- **TASK-034/035/036** (github star/updatePRTitle): SOL-012 invented a
  nonexistent `githubapi` package and a `usecase.Identity` parameter that
  doesn't exist on the real `CredentialResolver`/`UpdateIssue` usecase;
  corrected against the real `scm-integration-service` source.
- **TASK-039/040** (tenant-service team RPC): corrected two line-number
  guesses from SOL-013 (`server.go`'s `New()` is at 58–101, not 57–80) and
  added composition-root wiring (gRPC `Server` struct + `cmd/server/main.go`)
  that SOL-013's file list omitted but is required for the new RPC to be
  reachable at all.

Treat each `TASK-XXX.md`'s own citations as ground truth over its parent
`SOL-XXX.md` where they diverge — the same discipline
`missing-v2/tasks/README.md` established for missing-v1's solutions.

## Task index, grouped by solution

### SOL-004 — `ephemeralVm.*` (TASK-001–006)

| Task | Title | Depends on |
|---|---|---|
| [TASK-001](./TASK-001-ephemeral-vm-recipe-read-usecases.md) | git-gateway-service recipe/doctor/cleanup-command read usecases (Group 1) | none |
| [TASK-002](./TASK-002-ephemeral-vm-recipe-and-runtime-proto-wiring.md) | Proto RPCs + gRPC wiring + new `ephemeral_vm_runtimes` table for `listRuntimes` | TASK-001 |
| [TASK-003](./TASK-003-ephemeral-vm-group1-wscompat-channels.md) | wscompat channels for the 5 Group 1 reads | TASK-002 |
| [TASK-004](./TASK-004-ephemeral-vm-lifecycle-relay-usecase.md) | Group 2a lifecycle relay usecase (attach/suspend/resume/cleanup), `EmulatorRelay`-shaped | TASK-002 |
| [TASK-005](./TASK-005-ephemeral-vm-group2a-wscompat-channels.md) | wscompat wiring for Group 2a | TASK-004 |
| [TASK-006](./TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md) | **Honest blocker** — Group 2b (ssh-connection-type) needs new `agent/` outbound-SSH-client capability that doesn't exist; documents the gap, does not implement | none (blocked indefinitely) |

### SOL-006 — `speech.models.*` (TASK-007–008)

| Task | Title | Depends on |
|---|---|---|
| [TASK-007](./TASK-007-speech-add-desktop-only-namespace.md) | Add `speech` to `DESKTOP_ONLY_NAMESPACES` (reclassify — not a backend-go RPC) | none |
| [TASK-008](./TASK-008-update-bug-006-status.md) | Flip BUG-006's status + missing-v3 README's index row once TASK-007 lands | TASK-007 |

### SOL-005 — `starNag.*` (TASK-009–014)

| Task | Title | Depends on |
|---|---|---|
| [TASK-009](./TASK-009-star-nag-state-migration-and-domain.md) | New `star_nag_state` migration + domain types (tenant-service) | none |
| [TASK-010](./TASK-010-star-nag-state-repository.md) | `StarNagStateRepository` port + postgres adapter | TASK-009 |
| [TASK-011](./TASK-011-star-nag-simple-state-rpcs.md) | Proto + usecases + wscompat for dismiss/later/complete/disable/forceShow/onboardingCompleted | TASK-010 |
| [TASK-012](./TASK-012-star-nag-github-adjacent-rpcs-stub.md) | `ScmStarCheckPort` stub + openWeb/starOrca/agentValueMoment/showAgentValueMoment — ships now, no SOL-012 dependency | TASK-010 |
| [TASK-013](./TASK-013-star-nag-real-scm-star-check-adapter.md) | Swap the stub for a real `ScmIntegrationService.StarRepository` call | TASK-012, **and the SOL-012 task that adds `ScmIntegrationService.StarRepository`** (TASK-035, different solution) |
| [TASK-014](./TASK-014-star-nag-visibility-push-pipeline.md) | `starNag.subscribe`/`unsubscribe` via tenant-service → notification-service → wscompat push | TASK-009 |

### SOL-014 — `telemetry.track` (TASK-015–018)

| Task | Title | Depends on |
|---|---|---|
| [TASK-015](./TASK-015-telemetry-consent-identity-decision-doc.md) | **Product-decision document** (not code) — 4 concrete questions that must be answered first | none |
| [TASK-016](./TASK-016-telemetry-consent-tenant-service-field.md) | Consent field on tenant-service | **Blocked on TASK-015** |
| [TASK-017](./TASK-017-telemetry-event-allowlist.md) | Go event allowlist | **Blocked on TASK-015** |
| [TASK-018](./TASK-018-telemetry-forwarding-handler.md) | Stateless forwarding handler, replaces the no-op | Blocked on TASK-015/016/017 |

### SOL-008 — `terminal.create` host-local (TASK-019–022)

| Task | Title | Depends on |
|---|---|---|
| [TASK-019](./TASK-019-rename-spawn-terminal-no-compute-bound-error.md) | Rename `INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED` → `INFRA_TERMINAL_NO_COMPUTE_BOUND` in `SpawnTerminalSession` | none |
| [TASK-020](./TASK-020-rename-resolve-terminal-session-no-compute-bound-error.md) | Same rename for `resolveTerminalSession`'s parallel guard | none |
| [TASK-021](./TASK-021-frontend-surface-no-compute-bound-terminal-error.md) | Frontend: surface the new error code actionably via the existing `onError` callback | TASK-019, TASK-020 |
| [TASK-022](./TASK-022-environment-devserver-resolution-blocked-on-ephemeralvm.md) | **Honest blocker** — real `environmentId → devServerId` resolution needs SOL-004's ephemeralVm work | TASK-001–006 (different solution) |

### SOL-009 — `browser.profile*` (TASK-023–025)

| Task | Title | Depends on |
|---|---|---|
| [TASK-023](./TASK-023-agent-browser-profile-clear-default-cookies.md) | `agent/`: `profileClearDefaultCookies` via `agent-browser cookies clear` | none |
| [TASK-024](./TASK-024-agent-browser-profile-detect-browsers.md) | `agent/`: port desktop's cross-platform browser-detection logic (detection only, no decryption) | none |
| [TASK-025](./TASK-025-agent-browser-profile-import-from-browser.md) | `agent/`: port the real Keychain/DPAPI/keyring cookie-decryption pipeline — the large task; flags a security-trust-model note and an unresolved wire-args question | TASK-024 |

### SOL-010 — `onboarding.*` (TASK-027–030)

| Task | Title | Depends on |
|---|---|---|
| [TASK-027](./TASK-027-onboarding-relay-copy-channels.md) | `detectWindowsCapabilities`/`detectGhosttyConfig`/`setGitIdentity` — verbatim relay copies of the existing `onboardingDetectAgents` skeleton | none |
| [TASK-028](./TASK-028-onboarding-detect-agents-all-servers-fanout.md) | `detectAgentsAllServers` — fan-out loop over `ListDevServersForUser` | none |
| [TASK-029](./TASK-029-onboarding-get-preflight-status.md) | `getPreflightStatus` — relay to the agent's distinct Contract-B `preflight.check` | none |
| [TASK-030](./TASK-030-onboarding-open-gh-auth-terminal-blocked.md) | **Honest blocker** — `openGhAuthTerminal` needs `terminal.create` | TASK-019–025 (different solution) |

### SOL-011 — `git.cancelGenerate*` (TASK-031–033)

| Task | Title | Depends on |
|---|---|---|
| [TASK-031](./TASK-031-git-generate-cancellation-registry.md) | Narrow, worktree+kind-keyed `context.CancelFunc` registry (not a generic framework) | none |
| [TASK-032](./TASK-032-wire-git-cancel-generate-channels.md) | Wire `generateCommitMessage`/`generatePullRequestFields` to register; add the 2 `cancel*` channels | TASK-031 |
| [TASK-033](./TASK-033-verify-aicompleter-context-propagation.md) | Doc-only follow-up — verified `AICompleter` already propagates `ctx` correctly; real open question is agent-side | none |

### SOL-012 — `github.starOrca`/`updatePRTitle` (TASK-034–036)

| Task | Title | Depends on |
|---|---|---|
| [TASK-034](./TASK-034-scmintegration-proto-star-and-update-pr.md) | Proto: `StarRepository` + `UpdatePullRequest` RPCs on `ScmIntegrationService` | none |
| [TASK-035](./TASK-035-star-repository-usecase-and-wiring.md) | `StarRepository` usecase + 5 provider adapters + wiring + `github.starOrca` channel | TASK-034 |
| [TASK-036](./TASK-036-update-pull-request-usecase-and-wiring.md) | `UpdatePullRequest` usecase + wiring + `github.updatePRTitle` channel | TASK-034 |

### SOL-013 — `devServer.listForUser` team grants (TASK-039–042)

| Task | Title | Depends on |
|---|---|---|
| [TASK-039](./TASK-039-add-list-teams-for-user-proto-rpc.md) | Proto: new `ListTeamsForUser` RPC on tenant-service | none |
| [TASK-040](./TASK-040-implement-list-teams-for-user-usecase-and-grpc-wiring.md) | Thin usecase wrapping the already-existing `TeamRepository.ListUserTeamLayers` + composition-root wiring | TASK-039 |
| [TASK-041](./TASK-041-wire-devserver-listforuser-team-ids.md) | The actual bug fix — `channels_dev_server_access_control.go` calls the new RPC, populates `TeamIds` | TASK-040 |
| [TASK-042](./TASK-042-test-list-teams-for-user.md) | Tests: new usecase unit tests + wscompat regression test | TASK-041 |

## Cross-solution dependency graph

Three dependencies cross solution boundaries — easy to miss if you only
read one solution's task range:

```
TASK-034 (scmintegration proto: StarRepository) ──► TASK-035 (StarRepository usecase) ──► TASK-013 (starNag's real star-check adapter)
TASK-001..006 (ephemeralVm)                     ──► TASK-022 (terminal.create's environmentId→devServerId resolution)
TASK-019..025 (terminal.create)                 ──► TASK-030 (onboarding's openGhAuthTerminal)
```

Everything else is contained within its own solution's task range.

## Suggested implementation order

1. **No-dependency, quick wins first**: TASK-007/008 (speech reclassify),
   TASK-019/020/021 (terminal error rename + frontend surfacing),
   TASK-023 (browser cookie clear), TASK-027/028/029 (onboarding relay
   copies + fan-out + preflight), TASK-031/032 (git cancel registry),
   TASK-033 (doc-only), TASK-015 (telemetry decision doc — unblocks 3 more).
2. **Foundational proto/schema work** other tasks build on: TASK-039
   (tenant team RPC), TASK-034 (scmintegration star/PR proto), TASK-009/010
   (starNag state table), TASK-001/002 (ephemeralVm reads + runtime table).
3. **Then their dependents**: TASK-040→041→042 (devServer team grants,
   finishes BUG-013 end to end), TASK-035→036 (github star/updatePRTitle,
   finishes BUG-012), TASK-003/004/005 (ephemeralVm Group 1 + 2a wiring,
   finishes most of BUG-004), TASK-011/012 (starNag simple + stubbed RPCs),
   TASK-014 (starNag push pipeline).
4. **Cross-solution followers**: TASK-013 (once TASK-035 lands), TASK-022
   (once ephemeralVm's TASK-001–006 land), TASK-030 (once terminal.create's
   TASK-019–025 land).
5. **Larger, standalone `agent/` work**: TASK-024→025 (browser profile
   detect/import — the biggest single task in this set).
6. **Product-decision-gated**: TASK-016/017/018 (telemetry implementation,
   after TASK-015's decision doc is actually answered by a human).
7. **Permanently blocked, revisit later**: TASK-006 (ephemeralVm ssh-type
   lifecycle) — don't schedule until `agent/` grows outbound-SSH-client
   capability.

## What's intentionally NOT a task

- **BUG-007** (`files.*`) — confirmed false positive during the bug-report
  pass itself; no solution, no tasks.
