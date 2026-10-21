# Automated workspace setup: dedicated Setup tab

Status: design converged; implementation, local validation, and independent source review complete. Exact-head CI and merge authorization are tracked by [PR #29819](https://github.com/stablyai/orca/pull/29819).

## Decision and boundary

Run terminal-backed automated workspace setup in its own **Setup** tab using the existing new-tab path. Remove automated setup split placement, its preference/control, and its one-shot split/geometry state. Keep manual splits, issue-command splits, generic startup consumption, saved layouts, default-tab policy, and setup-to-agent sequencing.

This is PR 2. [PR 1 (#29810)](https://github.com/stablyai/orca/pull/29810) separately fixed background native-chat setup provisioning and merged first as `7f9b51cf5cc1de8769baa646b40c0c93af76be81`. This branch was rebased onto that exact merge before final review and relevant checks. Parent chat-publication and sibling-reattachment fixes, broad terminal ownership, corrupt saved-binding repair, and retries are outside this PR.

## Evidence and severity

* Confirmed pre-change mechanism: `shouldSeedWorktreePrimaryTerminal` treated split setup as a reason to create a shell even when the caller supplies native chat. Renderer `queueSetupAndIssueCommands`, runtime `provisionWorktreeTerminals`, and `spawnLocalStartupAndSetupTerminals` in `worktree-remote.ts` each branched on setup location. This PR reuses their existing dedicated-tab arms.
* The supplied incident investigation observed two leaves bound to one PTY and an independent equal-count chat-publication failure. This worktree does not establish the original missing-binding cause or two setup executions. Removing placement complexity is the user-requested product policy; it is not proof of fixing every frozen terminal.
* No demonstrated P0. P1 acceptance risks are replaying setup after host provisioning, losing requested startup/setup sequencing, or changing primary selection/background workspace selection. The validation below exercises actual creation routes and the preserved one-shot startup mechanisms.
* P2 tradeoff: automatic side-by-side setup placement disappears; manual splitting remains. Older execution hosts can still return existing split layouts, which updated clients must accept without moving/replaying setup.
* The first-terminal delayed delivery coupling exists in `ensureWorktreeHasInitialTerminal` for runtime-owned fallback commands. Ordinary desktop structured creation passes no backend startup and returns setup through local IPC, then uses host authority `none`, so its null-primary Setup path is already independent. The host native-chat route normally consumes setup before returning. Keep delayed delivery unchanged: no actual request proves the alleged native-chat P1. The post-PR-1 semantic review found no reason to expand this scope. The conditional STA-9417 expected-failure fixture does not establish the original incident's cause.

## Surfaces and selection

| Intent | Surfaces owed by this create with setup |
| --- | --- |
| Native chat | Requested chat plus Setup, without a split-anchor shell. |
| Terminal agent | Requested agent terminal plus Setup. |
| Plain terminal | Normal primary terminal plus Setup. |
| Setup only | Setup alone; preserve current suppression of default tabs. |
| Explicit default tabs | Existing template allocation/commands/title/color policy plus Setup. |
| No setup | Existing behavior. |

Issue automation retains its independent split from the normal primary pane, command/env, one-shot behavior, and focus policy. Setup stays unselected when another primary surface exists. Setup-only can select Setup when creation is still in view. Background creates/navigation away preserve workspace/tab selection and never reveal/focus a native window.

## Small existing mechanisms

1. Renderer: always create Setup with `pendingStartup`, title it through `setTabCustomTitle`, and preserve active primary/background options. Remove the location input from primary-shell and setup-only decisions. Retain host-spawn-result handling: `runtime-local-worktree-terminal-startup.ts` and local IPC omit consumed setup from fallback results, and remount restores its existing surface.
2. Runtime host: always `createTerminal` titled Setup; retain command construction, env, completion token/returned handle, fallback surface, `surfaceOwner`, and default-tab dressing. Remove setup's use of `splitTerminal` without changing generic split APIs.
3. Local IPC creation (`spawnLocalStartupAndSetupTerminals` in `worktree-remote.ts`): always use the existing new-tab branch; preserve platform runner/shell selection, sequencing wrapper, `activate: false`, and host authority. Accept old-host startup/layout evidence as authoritative.
4. Delete `pendingSetupSplitByTabId`, queue/consume actions, setup props/captured refs/bootstrap branch, setup-only geometry waits. Preserve generic geometry/resize functions used elsewhere and startup identity consumption. Do not remove regression purpose when updating fixtures: use manual/saved or issue-command splits for generic restore, purge, remount, and PTY ownership coverage.
5. Remove the Setup Script Location section and search registration. No new style/token/component is needed; follow `docs/STYLEGUIDE.md`.

## Settings and mixed versions

The implementation deletes `setupScriptLaunchMode` from live `GlobalSettings`, defaults, and launch types, and adds it to existing `stripRetiredGlobalSettings` so stale load/update/save keys are dropped. Remaining setting inputs are deliberate legacy-profile regression fixtures. There is no dead normalization or shared type retained for an unproven peer requirement.

Current `SettingsUpdate` is a strict explicit client-settings allowlist without this key; `RuntimeClientSettings` and `RuntimeClientSettingsUpdate` also omit it. Independent bounded history confirms the initial paired schema/projection at `b1973657ea6` (2026-05-21) and the pre-generated schema/types at `c84007c541d^` omit it; targeted key-history finds no paired-field introduction (see the Astra report for paths). Retire through the existing stripper, which already covers load, update and serialization; do not add a new normalization layer. Hosts own placement: an updated host ignores retired settings, and an old host may still produce a split. Updated clients accept returned layouts without replay or migration. Removing a client setting cannot force old hosts to adopt the new policy.

No protocol field/opcode, live-layout migration, scheduler, ownership store, command-string deduplication, or retry machinery is proposed. Runner arguments/env/cwd, Windows batch/shebang, WSL/SSH paths, and setup completion remain with existing functions.

## Alternatives

Changing only the default retains legacy split behavior and lifecycle complexity. Keeping the setting while ignoring it retains an unused contract unless actual old-peer evidence requires it. Moving all setup provisioning into a new service duplicates existing working paths and crosses PR 1. General binding enforcement and saved-layout repair solve broader problems and need separate evidence/design. Independent design and actual-diff review found no known smaller adequate approach; this is a scoped engineering judgment, not a mathematical optimality claim.

## Validation and review gates

Before implementation: Astra round 1 found no demonstrated unresolved P0/P1 in this scoped design, with concrete route/settings evidence and no known smaller adequate approach. Round 2 confirms the corrected local-IPC label, historical settings evidence, unchanged first-terminal delivery and strict PR 1/publication/reattachment boundary. The independent report is `docs/automated-setup-tab-astra-review.md`; implementation review remains separate.

Meaningful automated coverage: renderer/native-chat/terminal/setup-only/default-tab/background actual requests, host/remote no-split command/env preservation, sequencing/failure fallback, old-host returned layout/no replay, remount one-shot startup, issue-command/manual split/restore/purge regression intent. Run relevant tests with `ORCA_BACKGROUND_LAUNCH=1`, node/web typechecks, changed-file code-quality and format checks. Preserve platform-specific runner tests; report platforms actually exercised.

Rendered checks require rebuilt hidden Electron plus Playwright CDP; inspect tab count/selection/setup output and retained manual splits, with before/after evidence. The installed agent-browser CLI provides the version-matched Electron skill (`agent-browser skills get core`, then `agent-browser skills get electron`), now read; use it alongside Playwright CDP. The coordinator serialized the shared native-runtime lease after an initial local rebuild failure; the supported rebuilt hidden-app checks subsequently passed.

After implementation: Astra reviews actual final diff/tests and semantic overlap after PR 1 rebase. No merge until PR 1 confirmation, exact-head full `.github/workflows/pr.yml` successful aggregate `verify` / PR checks passed and all required checks, and parent approval through the mandatory blocking merge-gate ask. Use `--match-head-commit` and confirm the merge.


## Implemented validation record

Reviewed source head: `d96ae2ca6afdca919b4d7f8d85308363abe8b28b`, based on the exact PR 1 merge above. The follow-up documentation commit changes no source behavior. The independent review records no unresolved P0/P1 and explicit P2 tradeoffs.

- **Node tests:** final consolidated post-rebase selection passed 34 suites and 1,816 tests; two existing conditional expected-failure cases and two skips remain visible. The selection includes composed native-chat create payload/RPC/host routes for Claude and Codex, retired locations, setup-only/default tabs, wrapper/env/shell construction, failure fallback, one-shot startup, old-host layouts, manual/issue splits, remount, restore, sleep and purge behavior.
- **Types and static checks:** node/web typechecks, changed-file code-quality gate and staged Oxlint/format checks passed. The extra e2e project still reports 261 baseline diagnostics; baseline/final comparison by file and TypeScript error code found none added. This is not a clean e2e-project typecheck. A Bun `node:sqlite` suite-loader failure was avoided by executing the complete selected suites with the supported `test:node` command; no test-routing refactor is included.
- **Real rendered before/after:** rebuilt e2e-mode Electron host and paired client, both hidden, legacy vertical-split preference. Before: one terminal tab and two panes. After: Terminal 1 and Setup tabs, one Setup pane. Both displayed the real setup completion marker, retained background tasks selection, and supported another manual split. Post-rebase after-proof passed again. Screenshots are attached to the PR outside the source diff.
- **Rendered agent surfaces:** actual paired `agent.launch` created Claude native chat plus Setup with no shell anchor; the empty chat composer rendered and no prompt/model turn was submitted. A terminal-agent fixture CLI launched separately beside Setup and displayed its marker. Every native window was asserted hidden and unfocused.
- **Coverage retention:** the public `terminal.split` API activates by design, so its host layout fixture explicitly navigates away and tests reactivation. Genuine conditional old-host first-activation ownership/no-replay assertions remain in the unit fixture. Its expected-failure reconstruction is not presented as incident-cause proof.
- **Platforms actually executed:** macOS local Electron host plus paired desktop client. Windows/WSL command construction is tested, while live Linux, Windows, WSL and SSH execution were not performed. Existing saved layouts remain intact, and old execution hosts can still publish split layouts until upgraded.

Design/Astra artifacts are intentionally preserved in this PR. One-off probe sources and raw local logs live under ignored `.bench-fixtures/setup-split-removal-proof`; no images, profiles, auth data, or temporary test spec are committed. Merge still requires the exact current head's full PR workflow aggregate and all required checks, then the parent's mandatory blocking merge-gate approval.
