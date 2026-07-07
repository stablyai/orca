# Reliability Gates Implementation Plan

Date: 2026-07-02

Source context: [`docs/reference/reliability-pain-points-2026-06-30.md`](./reliability-pain-points-2026-06-30.md).

## Current Status

Last updated: 2026-07-03.

The first repo-side reliability batch is useful, but it should be treated as a first-layer regression net, not a finished terminal reliability program. Before final merge claims, rebase or retarget the stack onto fresh `origin/main` and verify it still includes the protections that landed there after the branch was cut.

Stack topology facts the rest of this plan depends on (verified 2026-07-02):

- `brennanb2025/fix-terminal-reliability` is simultaneously the integration worktree and the head branch of #7001, and it is the base branch of all five child PRs (#7004-#7008). Committing broad product changes to it would turn #7001 into the single large terminal PR this plan forbids and would silently change every child PR's diff.
- The committed branch contains only the manifest, checker, checker tests, and these docs (a 5-gate manifest as committed). Everything else this plan describes — the expanded manifest, product hardening, and new or updated tests across roughly 39 modified files plus 3 untracked files — exists only as uncommitted working-tree changes in this worktree. No evidence run below is reproducible from any pushed ref until the split branches are committed and pushed.
- The branch's merge-base with `origin/main` is roughly 97 commits stale. Fresh main renamed `terminal-webgl-paste-recovery.{ts,test.ts}` to `terminal-webgl-atlas-recovery.{ts,test.ts}` in #6949, so the current `xterm-addon.boundary-containment` manifest entry and its documented command break on rebase; see Fresh-Eyes Corrections.
- The manifest is the single source of truth for gate counts and per-gate status. Where this document records counts they are dated snapshots; `pnpm run check:reliability-gates` prints the current gate total.

Known Orca PR stack:

- [#7001](https://github.com/stablyai/orca/pull/7001), `Add reliability gate manifest`: merged on 2026-07-03. The manifest, checker, and plan docs are on main; [#7295](https://github.com/stablyai/orca/pull/7295) hardens the checker policy and registers the merged #7133/#7148/#7173/#7192 regression tests as partial gates with fresh main-side evidence.
- [#7005](https://github.com/stablyai/orca/pull/7005), `Add terminal snapshot freshness contract gate`: depends on #7001 and protects the stale-liveness/newborn-PTY class behind `terminal-session.snapshot-freshness`.
- [#7008](https://github.com/stablyai/orca/pull/7008), `Expand provider session replay ownership gate`: depends on #7001 and protects the agent/provider ownership class behind `agent-session.provider-ownership`.
- [#7004](https://github.com/stablyai/orca/pull/7004), `Contain xterm addon failures to terminal panes`: depends on #7001. The current branch has a first executable xterm containment slice for addon load, link-provider, search, and WebGL failure containment; it still needs live typed input/output survival before promotion.
- [#7006](https://github.com/stablyai/orca/pull/7006), `Prove visible terminal size convergence`: depends on #7001. The current branch now has a first deterministic renderer/main contract slice for post-spawn reconcile, split-right 0x0 recovery, applied `pty:getSize`, and resume-time size reassertion; it still needs live shell, SSH/remote, and Windows ConPTY geometry proof before promotion.
- [#7007](https://github.com/stablyai/orca/pull/7007), `Add persisted session upgrade fixture gate`: depends on #7001. The current manifest entry is still commandless in this branch, so treat it as a registered startup-upgrade gap until immutable fixture commands are wired.

Merged related product hardening:

- [#7054](https://github.com/stablyai/orca/pull/7054), `Prevent hidden terminal TUI overlap`: merged on 2026-07-01 with `verify`, Wayland terminal input, golden Linux E2E, golden mac E2E, and community tracking checks passing. This fixes the hidden regular-terminal TUI overlap class by scheduling bounded post-parse WebGL atlas recovery for risky hidden TUI redraws while keeping hidden bytes on the background write path.
- [#7133](https://github.com/stablyai/orca/pull/7133), `Fix stale terminal frames on worktree return`: merged on 2026-07-02 as a high-priority regression fix, root-caused on a live repro. Hidden-output restore skipped the destructive clear for alternate-screen snapshots, `?1049h` is a no-op on a pane already on the alt screen, and serialized frames skip blank cells, so the pre-hide frame bled through the final frame until a select or resize. The fix writes an alt-only `\x1b[?1049h\x1b[2J\x1b[H` preamble before alt-screen snapshot data (normal-buffer scrollback untouched, still no `3J`) and hardens the WebGL reveal path: dispose-on-bail with a single-addon invariant, refresh-always atlas reset, and a settled-frame pane-scoped repaint on tab reveal, worktree resume, and window wake. It supersedes the reverted #7058 approach and closes the alt-screen hole that #7054's hidden-output skip machinery made load-bearing. Its deterministic tests — the alt-only-clear-before-snapshot assertions in `pty-connection.test.ts`, plus `pane-webgl-renderer.test.ts`, `pane-reveal-repaint.test.ts`, and `terminal-visibility-resume.test.ts` — are the seed assertions for `terminal-output.scrollback-restore` and the WebGL side of `xterm-addon.boundary-containment` once the stack rebases.

- [#7148](https://github.com/stablyai/orca/pull/7148), `Match main terminal mirror character widths to the renderer`: merged on 2026-07-02, hours after #7133. Root cause of the residual post-#7133 bottom-row tears: the renderer xterm measures with Unicode 11 + ZWJ joining while the daemon headless mirror used default-width tables, so every positioned write after an emoji lands shifted and the tears are baked into the very mirror that restores replay — #7133's clear made restores faithful to the mirror and exposed it. The fix moves the unicode provider to `src/shared/terminal-unicode-provider.ts` and activates it in the headless emulator. Its red-green width test, `src/main/daemon/headless-emulator-unicode-width.test.ts` on main, is the seed assertion for the new `terminal-mirror.parser-parity` gate, and the shared provider plus `pane-terminal-options.ts` are the shared-construction seams that gate must assert on. #7148 also touches `pane-lifecycle.ts`, which both this worktree and #7004's branch modify — another confirmed rebase-conflict site.
- [#7173](https://github.com/stablyai/orca/pull/7173), `Fix Codex pane output tearing after app occlusion`: merged on 2026-07-03. A delayed background-origin Codex chunk carrying a stateful query could take the hidden live-write path after a newer snapshot restore had already rebuilt the renderer, overwriting newer state; an adversarial review pass added seq-restart guards so revived sessions (hibernation wake, kill plus cold-restore under the same PTY id) cannot silently freeze hidden output against a stale seq high-water mark. Its three red-proven tests in `pty-connection.test.ts` on main — reference-parse buffer equality over the ordered raw stream plus both revival guards — are exactly the exactness-oracle shape this plan prescribes and seed the hidden/live interleaving slice of `terminal-output.scrollback-restore`.
- [#7192](https://github.com/stablyai/orca/pull/7192), `Keep runtime mirror sized with desktop terminal resizes`: merged on 2026-07-03. Desktop `pty:resize` updated the PTY and renderer but never the runtime mirror, so the mirror parsed all subsequent bytes at its birth width, soft-wrapped TUI repaints into a corrupted ladder, and baked that corruption into every restore snapshot; the fix fans accepted desktop resizes to the mirror and serializes mirror reflow with queued output writes on the per-PTY write chain. This exposed a plan gap now fixed: the runtime mirror is a geometry authority in its own right, and renderer-vs-mirror convergence checks cannot see corruption upstream of the mirror. Its red-proven tests in `orca-runtime.test.ts` and `pty.test.ts` on main seed the mirror-geometry slice of `terminal-geometry.visible-convergence`.

Factory and skill status:

- [orca-internal #491](https://github.com/stablyai/orca-internal/pull/491), `Require reliability gates in factory reviews`: merged on 2026-07-01. This updates the factory review flow so terminal/session/provider/startup/release changes must name the relevant reliability class, invariant, gate or accepted gap, and validation evidence.
- [orca-internal #493](https://github.com/stablyai/orca-internal/pull/493), `Add Playwright reliability test skill`: as last reviewed, this still needed rebase/regeneration before merge because the reliability plan depends on Playwright tests being evidence-based, low-flake, and tied to named invariants.

Remaining work:

- Rebase or retarget the reliability stack on fresh `origin/main` before making final merge claims. Current main already contains terminal fixes that the stack must absorb, including hidden TUI overlap, input-lag, scrollback replay, Windows ConPTY keyboard reset, resume width flicker, remote mirror polling, and the #7133 stale alt-screen frame fixes. As part of the rebase, mechanically verify every declared `testFiles` entry in the manifest exists on fresh `origin/main`; the #6949 WebGL rename is a confirmed break. #7133 (merged 2026-07-02) touches `pty-connection.{ts,test.ts}` and `use-terminal-pane-global-effects.test.ts`, which this worktree also modifies, and `pane-webgl-renderer.{ts,test.ts}`, which #7004's branch also edits — expect real conflicts there. #7148 (merged 2026-07-02) additionally touches `pane-lifecycle.ts` and `headless-emulator.ts`, so the worktree's and #7004's pane-lifecycle edits must absorb its shared unicode-provider wiring. #7173 (merged 2026-07-03) rewrites the hidden live-write path in `pty-connection.{ts,test.ts}` and #7192 (merged 2026-07-03) touches `pty.test.ts` — both carry heavy worktree modifications, so the conflict surface keeps widening the longer the rebase waits. This worktree's replay/SSH/backpressure changes and #7004's containment changes must be rebased over #7133's alt-clear preamble, #7148's width fix, #7173's seq filtering, #7192's mirror resize fan-out, and the reveal-repaint hardening without weakening any side.
- Materialize the split: commit each uncommitted working-tree slice to its owning branch per the file assignment in the PR Split Plan, reset diverged child branches from the worktree versions of their files, and push. Only manifest, checker, and doc changes may be committed to `brennanb2025/fix-terminal-reliability` itself.
- Wire the aggregated non-blocking `reliability-gates` CI job (see Evidence Provenance And CI Wiring) so runtime and flake history accrue with machine provenance instead of hand-entered evidence.
- Split the current integration branch into focused PRs before final review and merge. Do not land this as one large terminal reliability PR; each PR should have its own invariant, evidence command, residual gaps, dependency note, and follow-up relationship to the rest of the stack.
- #7001 merged on 2026-07-03. Merge the gate-specific PRs only after resetting each from the worktree slice per the file assignment.
- Before merging each child PR, recheck it against the latest #7001/main because the shared manifest file can create normal stack drift or conflicts even when the PR currently reports clean.
- After merge, run the registered gate commands in soak and record runtime/flake evidence before promoting any gate to blocking.
- Update the factory skills again after the repo-side gate commands and CI jobs are stable, so agents can invoke exact commands instead of only requiring reliability evidence.
- Keep #7054's accepted gap visible: deterministic Claude-like TUI streams validated the renderer path, but live Claude Code was not part of that PR's validation. #7133 has since closed the alt-screen snapshot-restore hole in the same hidden-output machinery, and its buffer-merge root cause is exactly the class the `terminal-output.scrollback-restore` gate must make hard to reintroduce; the live-Claude validation gap remains.

## PR Split Plan

The current `brennanb2025/fix-terminal-reliability` branch is an integration branch, not the desired final review shape. It should be split into smaller PRs so reviewers can verify one reliability class at a time, bisect failures, and avoid merging a broad terminal lifecycle change without understanding which protection each file belongs to.

Branch and manifest ownership rules:

1. `brennanb2025/fix-terminal-reliability` is #7001's head branch. Only manifest, checker, checker-test, and plan-doc changes may be committed to it. Split items 2-6 go to their own branches, stacked on this branch and retargeted to `main` after #7001 merges.
2. #7001 may only declare gates whose `testFiles` all exist on `origin/main`. The checker's declared-file rule makes this self-enforcing: a manifest entry whose test files land in a later PR cannot pass CI inside #7001.
3. Every later PR owns its own manifest entries. It adds or upgrades the gates it implements — entry, `evidenceRuns`, and `assertionRefs` — in the same PR as the tests and hardening they reference. The manifest file is shared, but each entry has exactly one owning PR, and manifest conflicts are resolved by entry ownership, never by hand-merging divergent copies of an entry.
4. Commandless registered-gap entries (`protection: "none"`, no test files) may ride in #7001 because they reference nothing that can drift.
5. The integration worktree is the single authoritative copy of every overlapping file. Child branches that have diverged (for example, `resume-sleeping-agent-session.ts` on #7008's branch is ~156 diff lines behind this worktree) must be reset from the worktree slice, not reconciled by hand.

Recommended split:

1. Reliability gate manifest and plan docs.
   This PR owns `config/reliability-gates.jsonc`, the manifest checker hardening, checker tests, and this plan document. It should merge first because later PRs reference gate ids, evidence metadata, and promotion rules from the manifest. It should not include terminal product behavior changes.

2. Provider ownership and session replay safety.
   This PR owns the agent/provider identity invariant: activation, restore, sleep, hibernate, dedupe, clearing, and reconnect paths must not replay a provider session that is already owned, queued, pending, retained, or live in the workspace. It should include the provider-session ownership tests, repeat-activation lower-layer proofs, automatic resume claim coverage, same-session/wrong-session hook coverage, and any narrowly required product hardening.

3. Startup hydration, provider fanout, and targeted liveness.
   This PR owns startup-adjacent PTY registry hydration, targeted `pty.hasPty(id)` liveness, no-hot `pty:listSessions()` paths, Resource Manager polling scoping, SSH/provider unknown-liveness semantics, degraded-daemon fail-closed behavior, and related tests. It should depend on the manifest PR and should explicitly say that live SSH, WSL, remote-runtime, and production startup reconcile remain follow-up gates unless implemented in the same PR.

4. Terminal lifecycle observability.
   This PR owns compact anomaly breadcrumbs and bounded lifecycle traces for terminal lifecycle diagnosis. It should make failures easier to debug without claiming to prevent them. It should prove that diagnostics are compact, deduped or bounded, privacy-conscious, and included in the right local crash/diagnostic surfaces. Diagnostics-bundle export and live forbidden-transition artifacts should remain visible follow-ups until proven.

5. PTY output, IPC, and performance hardening.
   This PR owns daemon stream batching, main-to-renderer pending output caps, ACK/backpressure behavior, replay queue bounds, runtime/mobile stream byte budgets, and related perf-sensitive contracts. It needs the hardest review because small behavior changes here can cause input latency, hidden-output, memory, or ordering regressions. It should include explicit runtime budgets and should not promote any perf gate to blocking without soak evidence.

6. Live local PTY and E2E reliability slice.
   This PR owns the first live Electron/local PTY liveness gate. It should stay small: spawn a real terminal, prove one active PTY, type through focused xterm, verify process-visible output, hide/restore the workspace without duplicating or losing the PTY, resize and verify applied size, then exit and verify cleanup. It should remain `experimental` until CI/runtime history proves it is not flaky. Tab switch, app restart, SSH, WSL, Windows ConPTY, and scrollback restore should be explicit follow-ups unless included with equally strong oracles.

Mapping to the open stack and file assignment:

The six split items and the five open child PRs overlap; this mapping is authoritative. Every working-tree file must land in exactly one PR below. Four files contain changes from multiple reliability classes and must be split by hunk, with the earlier PR in the merge order owning its hunks first: `config/reliability-gates.jsonc` (per-entry ownership), `src/main/ipc/pty.ts` and its test, `src/renderer/src/components/terminal-pane/pty-connection.ts` and its test, and `src/renderer/src/store/slices/terminals.ts`.

1. #7001 (split item 1, manifest and plan docs): `config/scripts/check-reliability-gates.mjs`, `config/scripts/check-reliability-gates.test.mjs`, `docs/reference/reliability-gates-implementation-plan.md`, and the manifest restricted to gates whose test files exist on `origin/main` plus commandless gap entries.
2. #7008 (split item 2, provider ownership and replay safety): `src/renderer/src/lib/resume-sleeping-agent-session.ts` and test, plus its ownership slice of `terminals.ts`. Reset the branch from the worktree slice; keep the PR number for review continuity.
3. #7005 (snapshot freshness and targeted renderer liveness): `terminal-dead-session-reconcile.ts` and test, `use-terminal-pane-lifecycle.ts` and test, `use-terminal-pane-global-effects.test.ts`, and the `pty.hasPty` preload/API plumbing (`src/preload/api-types.ts`, `src/preload/index.ts`, `src/renderer/src/web/web-preload-api.ts`, the `hasPty` slice of `src/main/ipc/pty.ts`).
4. New PR (split item 3, startup hydration, provider contracts, no-hot listing): `hydrate-local-pty-registry.ts` and test, `daemon-pty-adapter.ts` and test, `daemon-pty-router.ts` and test, `degraded-daemon-pty-provider.ts` and test, `pty-session-id.test.ts`, `src/shared/pty-session-id-format.ts`, `src/main/providers/ssh-pty-provider.ts`, `ResourceUsageStatusSegment.tsx`, `resource-manager-session-polling.test.ts` (currently untracked), `store-session-cascades.test.ts`, and the SSH/liveness slices of `pty.ts`, `pty-connection.ts`, and `terminals.ts`.
5. New PR (split item 4, lifecycle observability): `terminal-lifecycle-diagnostics.ts` and `terminal-lifecycle-diagnostics.test.ts` (currently untracked).
6. New PR (split item 5, PTY output/IPC/perf hardening): `daemon-stream-data-batcher.ts` and test, `terminal-output-batching.test.ts`, `terminal-subscribe-buffer.test.ts`, and the pending-output-cap and replay/ACK slices of `pty.ts` and `pty-connection.ts`.
7. #7004 (xterm addon containment, outside the six split items): keep as its own PR; reset `pane-lifecycle.ts` and test from the worktree versions, and adopt fresh main's renamed WebGL test files during rebase.
8. #7006 (visible geometry, outside the six split items): keep as its own PR; any geometry hunks in `pty-connection.ts` belong to it.
9. #7007 (persisted upgrade fixtures): the gate is commandless with `protection: "none"`, so its manifest entry rides in #7001 under rule 4. Keep #7007 open only if it will deliver the actual fixture corpus and command; otherwise close it as absorbed.
10. New PR (split item 6, live local PTY E2E slice): `tests/e2e/terminal-live-pty-liveness.spec.ts` (currently untracked).

Merge order: #7001, then #7008, then #7005, then startup hydration/provider contracts, then lifecycle observability, then PTY output/IPC/perf hardening, then #7004, then #7006, then the live E2E slice. #7007 can merge any time after #7001 or be closed. The stack stays flat on #7001; each child rebases onto the merged state immediately before its own merge, and manifest conflicts are resolved by entry ownership.

If one later PR reveals a missing invariant in an earlier PR, update the earlier manifest entry or PR description before promotion rather than silently broadening the later PR's claim. The split is part of the reliability plan because reviewability, dependency clarity, and targeted rollback are themselves reliability controls.

Each split PR should follow Brennan's PR process before it is considered ready: write a scoped design doc, run delegated design review, implement from the reviewed doc, verify completeness against the original request and reliability gate, audit headline behavior, run `perf`, run the code-review/fix loop, run merge-confidence validation, open an unmerged PR, verify pushed state, and stabilize CodeRabbit/check findings. The PR text should describe that process as "Brennan's PR process"; do not mention the internal skill name in PR-facing text.

## PR Proof Contract

Every split PR must include a short proof section in its PR description before it can be treated as ready. This section should use direct evidence, not confidence language. Avoid absolute claims such as "this guarantees terminal reliability" or "this cannot regress performance." The valid claim is narrower: "this PR is safe to merge because the affected invariant, performance budget, and residual gaps were checked with the evidence below."

Required PR description sections:

- **Reliability invariant:** the class-level rule this PR protects and the recent issue, PR, or accepted gap that motivated it.
- **Material impact:** why this will meaningfully reduce escaped regressions, including which known bug class becomes harder to reintroduce.
- **Product change type:** docs/tooling, test-only gate, product hardening, diagnostics, perf hardening, or mixed.
- **Performance risk inventory:** whether the PR touches typing, focus, tab/workspace switch, visibility resume, resize, render, startup, provider listing, hidden output, PTY output, store subscribers, git/worktree scans, SSH, WSL, Windows, or mobile/relay paths.
- **No-regression evidence:** the exact count test, deterministic contract test, metric artifact, typecheck, or live run that proves the PR did not add unbounded scans, polling, hidden-pane wake loops, startup awaits, subprocess churn, renderer jank, or output buffering growth.
- **Correctness evidence:** the exact oracle and command proving the invariant. Tests that only prove implementation shape are not enough.
- **Provider/platform coverage:** local, daemon, SSH, WSL, remote-runtime, mobile/relay, macOS, Linux, and Windows must be marked covered, unaffected, or accepted-gap.
- **Residual gaps:** what this PR still does not prove. These gaps must remain in the manifest until a later PR removes them.
- **Promotion status:** whether the gate is `none`, `partial`, or `active`, and why it is not promoted beyond its current maturity.
- **Rollback or demotion rule:** what signal should cause the PR's gate to be demoted, disabled, or followed up.

Performance rule:

- A reliability PR is incomplete if it adds polling, global session listing, provider fanout, hidden-pane renderer wakeups, startup-critical awaits, repeated resize IPC, subprocess churn, unbounded output queues, broad store subscriptions, or uncapped diagnostics without a deterministic count test or metric budget.
- `pty:listSessions()` remains a global management/diagnostic operation, not a hot-path liveness primitive. Typing, focus, tab/workspace switch, visibility resume, resize, render, and per-pane liveness paths should use targeted APIs or cached ownership unless a PR provides measured proof that the broader call is safe.
- Any PR touching git/worktree scans, SSH git providers, WSL paths, cleanup, or startup repository enumeration must include the `git-crash-perf` style proof: bounded subprocesses, timeout/abort behavior, provider parity, and no startup-critical scan.
- Any PR touching terminal/session/provider/startup code must use the terminal-session reliability contract plus a performance budget. A green reliability test without a perf proof is not enough.
- Any PR that changes PTY output, IPC batching, ACK/backpressure, replay, or hidden-output behavior (split item 5 especially) must include a before/after run of an existing terminal perf artifact — `test:e2e:terminal-perf:scale:report` or the typing-latency specs — on the same machine, with both results in the PR description. Deterministic byte/count contracts prove bounds; only the perf artifact proves interactive latency did not regress.
- The gates themselves are a performance surface. Every command-backed gate must declare a runtime budget in the manifest, unit-layer gate commands should stay in single-digit seconds, and the aggregated CI job in Evidence Provenance And CI Wiring must stay inside its own wall-clock budget so reliability coverage does not degrade the development loop it protects.

Per-PR proof expectations:

1. Reliability gate manifest and plan docs.
   Performance proof: no runtime product path changes. Checker runtime should stay cheap and deterministic, and manifest validation should not depend on network calls or live providers.
   Materiality proof: the checker prevents overclaiming by requiring evidence metadata, existing test files, command-backed assertions, covered scope, and clear `none`/`partial`/`active` status.

2. Provider ownership and session replay safety.
   Performance proof: activation and replay checks must be bounded by indexed workspace-local state, not repeated provider listing or O(records x pending-startups) scans. Tests should include repeat activation and bounded-work assertions where scans are introduced.
   Materiality proof: this blocks the class where an inactive or hidden but valid provider session is mistaken for unowned and resumed again.

3. Startup hydration, provider fanout, and targeted liveness.
   Performance proof: startup hydration must not block first usable UI, must expose bounded counters, and must not multiply provider/git scans across repos and worktrees without a budget. Hot interaction paths must prove zero broad `pty:listSessions()` calls.
   Materiality proof: this prevents stale global snapshots or failed provider observations from closing or replacing the wrong terminal, while reducing session-listing fanout.

4. Terminal lifecycle observability.
   Performance proof: breadcrumbs and traces must be capped, primitive-only, deduped or ring-buffered, and must not serialize terminal output, filesystem trees, scrollback, or large state. Tests must prove caps and sanitization.
   Materiality proof: this does not itself prevent regressions, but it materially shortens future diagnosis by preserving the lifecycle facts needed to debug ownership, liveness, restore, resize, and replay failures.

5. PTY output, IPC, and performance hardening.
   Performance proof: this PR must carry the strongest perf evidence in the stack: byte caps, queue caps, ACK/backpressure ordering, active-output priority, hidden-output behavior, and no unbounded renderer/main buffering. It should not become blocking until soak data shows stable runtime and no unexplained flakes.
   Materiality proof: this protects the freeze/input-lag/memory-growth class where background or high-volume terminal output harms the active terminal or the app.

6. Live local PTY and E2E reliability slice.
   Performance proof: the Playwright gate must be small, serial where needed, artifact-producing, and timed. It should prove the user path without becoming a broad slow/flaky suite. Runtime and flake history are required before promotion.
   Materiality proof: this covers the layer that fake providers cannot prove: real Electron terminal spawn, keyboard input, process-visible output, hide/restore, resize, and cleanup.

## Factory And Skill Follow-Up

The current factory skills are close enough that the next step should be targeted edits, not a large new skill stack. The terminal-specific skill already exists, and Brennan's PR process already requires design review, perf review, code review, validation, pushed-state checks, and PR stabilization. The missing factory behavior is that reviewers and validators should explicitly fail PRs that omit the PR Proof Contract above.

Recommended skill/factory updates:

1. Update `terminal-session-reliability`.
   Add the PR Proof Contract as a required output for terminal/session/provider/startup PRs. The skill should require reliability invariant, material impact, performance risk inventory, no-regression evidence, provider/platform coverage, residual gaps, promotion status, and rollback/demotion rule.

2. Update `review-code`.
   Make missing proof-contract sections a review finding for P0-capable terminal/session/provider/startup/release surfaces. Reviewers should not accept "tests pass" as enough when the PR lacks a named invariant, perf budget, provider/platform matrix, or accepted-gap statement.

3. Update `brennan-test-changes`.
   Require validation reports to say whether the relevant reliability gate command ran, whether the evidence proves the user-visible invariant, whether the test layer is sufficient, and whether any skipped SSH, WSL, Windows, remote-runtime, mobile, or live-Electron path is an accepted gap.

4. Update `playwright-reliability-tests`.
   Add the live-terminal reliability bar directly: Playwright terminal tests must prove real input/output or visible degraded state, use deterministic event oracles instead of blind sleeps, record runtime/artifacts, and stay `experimental` until flake history supports promotion.

5. Update `perf`.
   Add the PR Proof Contract's no-regression evidence language so perf reviewers require deterministic count tests or metric artifacts for polling, global session listing, provider fanout, hidden-pane wakeups, startup awaits, subprocess churn, output queue growth, and broad store subscriptions.

6. After the repo-side gate commands stabilize, update factory prompts to invoke exact gate ids and commands.
   Do this after the PRs land or after their commands are stable enough to reference. Before then, the factory should require the gate class and evidence, but should not hard-code commands that may still split or rename during PR extraction.

Do not add a separate broad "terminal reliability reviewer" skill unless the existing skills fail to enforce this contract after these edits. Too many overlapping skills can make agents diffuse responsibility; the better shape is one terminal reliability contract plus required calls from design, review, perf, Playwright, and validation stages.

## Coverage Reality Check

This first stack is useful, but it must not be described as "terminal reliability is covered." The executable protection in this branch covers a deliberately small first slice of recent escaped classes:

- stale local/daemon liveness snapshots closing newer PTY bindings;
- provider-session replay ownership for several active, inactive, queued, pending, live, retained, same-session hook, and wrong-session hook records, with real hook timing through Electron still explicitly partial;
- targeted `hasPty` liveness after visibility resume instead of hot-path global `listSessions`;
- degraded daemon fallback fail-closed behavior for restored worktree-scoped and legacy/non-scoped ids;
- SSH provider listing/`hasPty` failures treated as unknown rather than destructive ownership evidence, plus mocked provider/renderer coverage for deferred SSH attach, passphrase cancellation, transient deferred reattach failure, and expired deferred relay fallback;
- remote replay coalescing, FIFO ordering, and bounded burst-tail coalescing at the renderer unit layer;
- visible geometry contract behavior for delayed split layout settle, 0x0 split-right recovery, applied-vs-requested `pty:getSize`, and resume-time size reassertion;
- boot-time local PTY registry hydration counters for repo/worktree enumeration, skipped SSH repos, adapter/session listing, registration/skips, duration, and failure phase;
- terminal lifecycle anomaly breadcrumbs recorded into renderer crash diagnostics with dedupe and compact identity fields;
- live local Electron PTY spawn, active PTY listed exactly once, focused xterm keyboard input, process-visible output, repeated workspace hide/restore of the same PTY, actual resize propagation, and exit cleanup.

Those gates should catch re-regressions in those classes, and the tests are intentionally deterministic. They mostly use renderer-unit, renderer-state, provider-contract, or fixture layers because those layers provide precise oracles with low flake risk. That is a strength for the classes they cover.

The manifest also contains commandless registered gaps for persisted-session upgrade fixtures, Windows ConPTY, startup color-query handling, and other future gates. Those entries are useful planning structure, not executable protection. Visible geometry convergence, xterm addon containment, IME/native text forwarding, runtime/mobile streams, and startup hydration counters now have first executable contract slices, but they remain `experimental` until they have repeatable CI/runtime history and red-green evidence. Output backpressure now has daemon stream and main pending-output contract slices, but the broader live perf budget remains experimental until it has repeatable metric artifacts, runtime history, and red-green evidence. The live local PTY gate now has a first executable Playwright slice that includes repeated workspace hide/restore of the same PTY, but it remains `experimental` until it has repeatable CI/runtime history and red-green evidence.

The critique that this stack is still shallow is fair. The current gates do not yet prove:

- tab-switch restore, scrollback after restore, app restart persistence, and non-local live providers;
- Windows ConPTY behavior, including shell resolution, cursor restore, rewrite repaint, CJK/IME edge cases, kitty/input protocol behavior, and activation hangs;
- terminal input latency, throughput, hidden-output pressure, renderer CPU, and store/subscriber hot paths under load;
- IME and synthetic input forwarding across macOS, Windows, Linux/fcitx/Sogou, Vietnamese, CJK, Arabic, paste, and modifier paths;
- focus recovery after browser/terminal handoffs, tab switches, app restart, and non-local provider restore;
- daemon degraded spawns, stale bootstrap, remote-runtime startup, SSH/WSL provider boundaries, and mirror polling;
- scrollback clearing/restoration correctness across hidden output, snapshot replay, and restore.

Those missing classes already appear in the full pain-points report, but this implementation plan should keep them visible so the first stack does not become false confidence.

## Fresh-Eyes Corrections

The follow-up reviews changed the plan in several concrete ways:

- Windows/IME/CJK are not covered by the current executable stack. Orca has useful unit coverage and product logic for local Windows ConPTY compatibility, including withholding Kitty keyboard protocol for local native Windows panes, but no live Windows ConPTY gate proves post-agent ordinary keys, shell parity, CJK repaint, cursor restore, resize readback, or real IME composition.
- SSH restore is better covered than the first manifest draft said, but only at store/provider/main/renderer contract layers. The current gate asserts deferred wake metadata, deferred attach/passphrase/expired-relay contracts, and unknown-liveness behavior with fake transports; it does not prove a live SSH relay, WSL, remote-runtime mirror polling, false-live visual state, or real network reconnect timing.
- Perf/backpressure is currently deterministic byte-accounting proof, not live responsiveness proof. The branch asserts daemon `write(false)`/`drain` behavior, cross-session drain priority for flush-immediate output, pure-backpressure cleanup, and main pending-output caps; it does not yet prove renderer parse pressure, event-loop delay, active key latency, or live hidden-output flood behavior.
- Daemon startup reconcile remains a mechanism, not a production-proven startup behavior. Either wire it with dry-run diagnostics and prior-worktree aliases, or keep it as an accepted gap with a named owner.
- Gate evidence is still too easy to hand-enter. The checker now prevents obvious metadata overclaims, but it does not prove the registered command was run in CI, preserve artifacts, or verify that each declared assertion executed. Add machine-checkable artifact/CI-run provenance before promoting gates to blocking.
- Manifest evidence in this worktree is not yet durable. Three referenced test files are untracked (`resource-manager-session-polling.test.ts`, `terminal-lifecycle-diagnostics.test.ts`, `tests/e2e/terminal-live-pty-liveness.spec.ts`) and roughly 39 more files carry uncommitted modifications. Until each slice is committed and pushed to its owning split branch, the manifest references proof that CI cannot run and that no one can reproduce from a ref.
- Fresh `origin/main` renamed `terminal-webgl-paste-recovery.{ts,test.ts}` to `terminal-webgl-atlas-recovery.{ts,test.ts}` and added `pane-webgl-context-recovery.test.ts` and `pane-webgl-renderer.test.ts` in #6949. The `xterm-addon.boundary-containment` gate and its documented command reference the old filename and will fail the checker after rebase; the gate should adopt the renamed and new tests during the rebase. #7133 (merged 2026-07-02) further modified `pane-webgl-renderer.{ts,test.ts}` and added `pane-reveal-repaint.{ts,test.ts}` and `terminal-visibility-resume.{ts,test.ts}`; the containment gate should evaluate those reveal-hardening tests for adoption in the same sweep. This is a confirmed instance of the stale-branch risk, and it shows the fresh-main review must include a mechanical testFiles-vs-main sweep, not only behavioral spot checks.
- This document itself drifted from the manifest it describes (a prior revision said 23 gates, 13 partial/10 none, while the manifest held 24 gates, 15 partial/9 none). Treat the manifest as authoritative and this document's counts as dated snapshots.
- The Resource Manager status segment no longer polls broad `pty:listSessions()` for its closed-popover badge in this branch. Broad session inventory is now scoped to the open Resource Manager and explicit kill/restart refresh paths; the no-hot-listing plan still needs status/diagnostic budgets and broader Electron counters before promotion.
- Boot-time local PTY registry hydration now exposes a debug snapshot and deterministic tests for retry state, SSH skip-before-worktree-enumeration, local registration counters, adapter/session listing counts, recoverable adapter-list failures, fatal hydration failures, router adapter fanout, duration, and large daemon lists. This is still only a startup-hydration counter slice; it does not prove focus, typing, tab switch, workspace switch, render, high-session provider fanout, or real Electron startup budgets.
- Terminal lifecycle anomaly diagnostics now record compact crash breadcrumbs in addition to console warnings. This is useful support evidence, not yet the full pane lifecycle trace buffer requested in the pain-points report.

## Fresh Main Architecture Findings

These findings came from focused reviews of current terminal lifecycle, renderer/input/perf, and provider/platform/startup code against freshly fetched `origin/main`. They are not all regressions introduced by the reliability-gate branch. They are the places the plan must cover before claiming broad terminal reliability.

Current coverage already exists in more places than the first gate stack showed:

- `terminal-dead-session-reconcile.test.ts`, `resume-sleeping-agent-session.test.ts`, and `pty-connection.test.ts` have substantial deterministic lifecycle coverage. A focused run of those files passed 292 tests.
- Existing E2E/perf tests include terminal typing latency, hidden TUI visual restore, long-table scroll restore, daemon slow-init PTY restore, SSH localhost, and terminal tab-switch SIGWINCH restore.
- Existing scripts include terminal perf report commands such as `test:e2e:terminal-perf`, `test:e2e:terminal-perf:scale`, `test:e2e:terminal-perf:scale:report`, and `test:e2e:terminal-perf:check-report`.

The problem is that these tests are not yet organized into reliability gates with named invariants, owners, maturity, runtime budgets, flake history, red/green evidence, and promotion rules. Some also need review before promotion because a useful regression test can still be too broad, too slow, or too flaky to be a blocking gate.

Local validation evidence from this review pass:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/terminal-dead-session-reconcile.test.ts \
  src/renderer/src/lib/resume-sleeping-agent-session.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts
```

Result on 2026-07-01: 3 test files passed, 292 tests passed, duration 6.04s. This asserts the current deterministic lifecycle/unit layer is healthy in this worktree; it does not prove the broader live/platform/provider/perf gaps.

The provider-session ownership gate now includes the queued/pending resume bridge from fresh `origin/main`: automatic resumes thread `resumeProviderSession` through `pendingStartupByTabId`, claim `automaticAgentResumeClaimsByTabId`, and treat pending startup, time-bounded runtime claims, and live agent statuses as provider-session ownership. The queued/pending claim scan is indexed once per activation so replay protection does not rescan every pending startup for every sleeping record. It also asserts live hook evidence claims only the matching provider session; a wrong-session hook cannot claim a replayed sleeping record; and stale automatic bridge claims cannot suppress recovery forever.

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/lib/resume-sleeping-agent-session.test.ts
```

Result on 2026-07-01: 1 test file passed, 34 tests passed, duration 7.86s. This focused command asserts repeat activation or replayed sleeping records do not launch a second resume for the same provider session while the first resume is still pending, queued pending-startup provider-session ids are read once per activation rather than once per replayed record, a live hook for the same provider session owns the replay, and a wrong-session hook does not. It does not yet prove real hook timing through Electron or a full Electron workspace activation loop.

Structural manifest validation also passed locally:

```sh
pnpm run check:reliability-gates
```

Result on 2026-07-01 after the first expansion: reliability gate manifest check passed for 22 gates. This validated the manifest schema/metadata shape only; it did not prove that the registered commands covered the full terminal runtime.

After the broader architecture review and fresh-agent review, the manifest was expanded further, including a dedicated WSL restore contract instead of burying WSL under SSH/remote coverage, and later the three convergence/escape-detection gaps registered after the #7133/#7148 saga. As of 2026-07-03, main's manifest holds 27 gates split 9 `partial` (gates whose evidence exists on main itself, including the #7133/#7148/#7173/#7192 regression tests) and 18 `none`; the pending stack raises more gates to `partial` as its slices land. These counts are dated snapshots, and the manifest itself is authoritative. The new entries are intentionally `experimental`; a few now have first executable slices, while others are still commandless gap markers. They are not active protection until each gate gets an implemented command, red/green proof, runtime evidence, and promotion history.

The manifest checker now enforces the review lessons that were easy to miss manually:

- declared `testFiles` must exist;
- every declared executable `testFiles` entry must be referenced by at least one gate command, so a manifest cannot borrow credibility from a file the registered command does not run;
- command-backed gates cannot use title selectors such as `-t`, `--grep`, or `--testNamePattern`, because title drift silently changes coverage;
- every gate must declare `protection: none | partial | active`;
- commandless gates must declare `protection: "none"`, while command-backed gates must declare at least `protection: "partial"`;
- `protection: "active"` is reserved for blocking gates with stable flake history and complete red/green evidence;
- `partial` and `active` gates must include at least one passed structured `evidenceRuns` entry whose command exactly matches the gate command;
- `none` gates must have no evidence runs, so planning gaps cannot look like tested coverage;
- `partial` and `active` gates must include `assertionRefs` that point to declared test files and name the invariant assertions inside those files;
- `none` gates must have no assertion refs, so planning gaps cannot borrow credibility from unrelated tests;
- every gate must split risk scope from covered scope with `coveredPlatforms`, `coveredProviders`, and `coverageNotes`;
- `coveredPlatforms` and `coveredProviders` must be inside the declared risk scope, and passed evidence-run platforms must appear in `coveredPlatforms`;
- `soak` and `blocking` gates must have soaking/stable flake evidence and complete red/green evidence.

How to read the manifest:

- `platforms` and `providers` describe the affected risk scope for an invariant. They do not mean the current command exercises every listed platform/provider.
- `coveredPlatforms`, `coveredProviders`, and `coverageNotes` describe the scope actually covered by current evidence. Empty `coveredProviders` on a partial gate usually means renderer/state/RPC contract coverage, not a real provider run.
- `protection: "none"` means a registered gap only; `protection: "partial"` means useful executable coverage that is not blocking protection yet; `protection: "active"` means the gate is blocking and has stable evidence.
- `evidenceRuns` are factual run records: date, runner, platform, exact command, result, duration, and summary. A local passed run supports `partial` coverage; it does not imply CI stability or flake history.
- `assertionRefs` explain which assertion groups in the listed test files carry the gate. This is especially important for shared files like `pty-connection.test.ts`, where the whole file passing is not the same as the whole file being relevant.
- `oracle`, `redGreenEvidence`, and `knownGaps` are the authoritative source for what is actually proved today.
- Commandless `experimental` gates are registered gaps, not active protection.

New or expanded manifest entries:

- `terminal-platform.live-pty-liveness`
- `terminal-platform.windows-conpty-liveness`
- `terminal-performance.no-hot-list-sessions`
- `terminal-performance.output-backpressure-budget`
- `terminal-performance.input-throughput`
- `terminal-performance.daemon-stream-backpressure`
- `terminal-performance.store-and-git-hot-paths`
- `terminal-provider.daemon-startup-degraded-contract`
- `terminal-provider.ssh-remote-reattach-contract`
- `xterm-addon.boundary-containment`
- `terminal-output.scrollback-replay-fifo`
- `terminal-output.scrollback-restore`
- `terminal-input.ime-and-synthetic-forwarding`
- `terminal-input.windows-conpty-keyboard-reset`
- `terminal-render.windows-cjk-repaint`
- `terminal-shell.windows-resolution-parity`
- `terminal-capability.startup-color-query`
- `terminal-runtime.mobile-stream-budget`
- `terminal-mirror.parser-parity`
- `terminal-observability.restore-convergence-selfcheck`
- `terminal-render.pixel-refresh-repair`

The visible geometry gate now has its first deterministic renderer/main contract slice:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/pty-size-reconcile.test.ts \
  src/renderer/src/components/terminal-pane/split-right-white-screen.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts \
  src/main/ipc/pty.test.ts
```

Result on 2026-07-02: 4 test files passed, 481 tests passed, duration 5.98s. This focused command asserts delayed hidden split-layout settles are forwarded instead of stopping on a fixed frame budget, unmeasurable frames do not count as settled, visible 0x0 split-right panes get a nonzero recovery size while hidden background 0x0 panes are not forced to desktop size, `pty:getSize` reports applied size when a provider can expose it, and visibility resume reasserts only real PTY/xterm drift without falling back to `listSessions`. It does not yet prove shell-visible `stty`, SSH/remote geometry, Windows ConPTY geometry/readback, or full Electron geometry under real split/tab/app-restart workflows.

The live local PTY gate now has its first executable Electron slice:

```sh
pnpm run ensure:electron-runtime && npx playwright test \
  tests/e2e/terminal-live-pty-liveness.spec.ts \
  --config tests/playwright.config.ts --project electron-headless --workers=1
```

Result on 2026-07-02 after adding two workspace hide/restore cycles, exact active-PTY listing, and actual resize convergence: 1 Playwright test passed, test body 8.6s, full command 58.6s including build/setup. This one local macOS run asserts a real Electron local terminal binds a PTY, lists the active PTY id exactly once, accepts keyboard input through focused xterm, renders process output markers, preserves the same PTY id through repeated worktree switch-away/switch-back cycles, accepts additional keyboard input after each restore, applies an actual `pty:getSize` change after viewport resize, reports the same process-visible size, exits the probe, exits the shell, and removes the PTY id from `pty:listSessions`. It does not yet prove tab switch within the same worktree, scrollback after restore, app restart persistence, daemon, SSH, WSL, remote-runtime, Linux CI stability, or Windows ConPTY behavior.

The IME/native-text gate now has its first deterministic renderer-unit slice:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/terminal-ime-native-text-forwarder.test.ts \
  src/renderer/src/components/terminal-pane/terminal-ime-input-source.test.ts \
  src/renderer/src/components/terminal-pane/terminal-paste-runtime.test.ts
```

Result on 2026-07-02: 3 test files passed, 63 tests passed, duration 887ms. This registers existing native-text, input-source, and paste/runtime forwarding contracts as a reliability gate slice. It does not prove real OS IME automation, Windows ConPTY post-agent keyboard reset, Arabic/RTL, JIS-yen, or the full CJK/Vietnamese/platform matrix.

The xterm addon containment gate now has its first deterministic renderer-unit slice and product hardening for core addon load failures:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/lib/pane-manager/pane-lifecycle.test.ts \
  src/renderer/src/lib/pane-manager/terminal-link-provider-guard.test.ts \
  src/renderer/src/components/terminal-search-safe-find.test.ts \
  src/renderer/src/lib/pane-manager/pane-webgl-refresh-lifecycle.test.ts \
  src/renderer/src/components/terminal-pane/terminal-webgl-paste-recovery.test.ts
```

Result on 2026-07-02: 5 test files passed, 39 tests passed, duration 370ms. This focused command asserts a core addon `loadAddon` throw is pane-scoped and later addons still load, link provider throws degrade to no-link results, search decoration positive-integer crashes return `false` instead of escaping, and WebGL attach/refresh/recovery failures stay contained. It does not yet prove typed PTY input/output survives a live addon failure in Electron, nor WebGL dispose/reset throws across active, hidden, and resumed panes.

The runtime/mobile stream budget gate now has its first deterministic runtime-RPC slice:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/rpc/terminal-subscribe-buffer.test.ts \
  src/main/runtime/rpc/terminal-output-batching.test.ts \
  src/main/runtime/rpc/terminal-multiplex.test.ts
```

Result on 2026-07-02: 3 test files passed, 29 tests passed, duration 2.78s. The covered contracts assert mobile initial snapshots downgrade until they fit the 512KB budget, requested binary snapshots downgrade until they fit the 2MB budget, binary live output queued while the initial snapshot is serializing stays within 256KB while preserving the newest tail, large binary output is split into 48KB-or-smaller frames, output bursts are coalesced before emission, aborted subscribes do not register stale listeners, and stale mobile resize re-stream completions are dropped. It does not yet decide JSON subscribe fallback parity/deprecation.

The replay/scrollback gate now has its first executable slice:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts
```

Result on 2026-07-02: 1 test file passed as part of the focused pty-connection validation, with 255 tests in that file. The relevant replay assertions cover four replay invariants: remote replay payloads that overlap before parsing starts intentionally coalesce to the latest payload, a replay whose xterm parsing has already started is not overwritten by a newer replay, multiple replay notifications accepted after parsing starts drain FIFO, and burst tails are bounded while keeping the newest snapshot. It does not yet prove fresh-main `clearBeforeReplay` metadata, metadata-only replay, or hidden-output/live-output interleaving.

The no-hot-`listSessions` gate now has its first executable slice and product hardening. The renderer/preload/main path exposes `pty.hasPty(id)` and uses targeted liveness on visibility resume and first input after resume, instead of calling global `pty:listSessions()` from that hot path. The resize-on-resume slice also asserts it uses targeted `getSize` plus `resize` rather than broad session listing. Light tab switches and visible active-state resume now assert they do not call `pty:listSessions`, `pty.hasPty`, or `pty.getSize`; a representative active-PTY case proves the scheduler hint `setActiveRendererPty` is the only allowed PTY API call there. Resource Manager broad session inventory is now scoped to the open popover instead of polling for its closed badge.

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/terminal-dead-session-reconcile.test.ts \
  src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts \
  src/renderer/src/components/status-bar/resource-manager-session-polling.test.ts \
  src/renderer/src/components/terminal-pane/use-terminal-pane-global-effects.test.ts
```

Result on 2026-07-02: 5 test files passed, 321 tests passed, duration 6.34s. The focused no-hot command asserts visibility resume prefers targeted `hasPty` even when `listSessions` is available, first input after visibility resume calls targeted `hasPty` once, resize re-assertion after visibility resume uses `getSize`/`resize` without `listSessions`, light tab switches and visible active-state resume avoid `listSessions`/`hasPty`/`getSize` fanout while still allowing the active PTY scheduler hint, SSH/remote broad listing is skipped, Resource Manager broad session inventory polling is scoped to the open popover, panes close only on authoritative `false`, and unknown liveness keeps panes alive. It does not yet count raw focus, workspace switch, render, high-session typing, or real provider fanout in Electron.

The store/git hot-path gate now has its first boot-hydration counter slice. This is not broad interactive perf coverage; it is the narrow startup-adjacent part that previously had no measurable budget.

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/memory/hydrate-local-pty-registry.test.ts
```

Result on 2026-07-02: 1 test file passed, 8 tests passed, duration 0.342s. The focused command asserts provider-unavailable hydration does not scan repos/worktrees/providers and remains retryable, SSH repos are skipped before worktree enumeration, local daemon sessions are registered with debug counters for repo/worktree/adapter/session/register/skip/duration fields, recoverable adapter-list failures are counted without failing the whole hydration pass, fatal hydration failures record failed phase and error message, router-backed hydration records multi-adapter fanout counts, pre-existing pid rows are not clobbered, and large daemon session lists hydrate without spreading into argument-limit failures. It does not yet count store recomputes, git status requests, provider listings, focus, typing, tab switch, workspace switch, render, or high-session Electron fanout.

The degraded-daemon provider contract now has its first executable slice and product hardening. Existing-session operations fail closed when ownership is unknown, and restored daemon session ids, including legacy/non-worktree-scoped ids, cannot silently spawn a local fallback PTY under the old id. Fresh degraded-mode PTY creation still intentionally routes through fallback when the caller marks it as new, and process inspection returns benign defaults for unknown ownership instead of leaking fail-closed routing errors into window-close flows.

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/daemon/degraded-daemon-pty-provider.test.ts \
  src/main/daemon/daemon-pty-adapter.test.ts \
  src/main/daemon/daemon-pty-router.test.ts
```

Result on 2026-07-02: 3 test files passed, 107 tests passed, duration 2.54s. Focused provider validation asserts discovered daemon sessions route to the daemon, fresh degraded-mode PTYs route to fallback only when marked new, router spawn discovers uncached existing sessions before choosing an adapter, router spawn fails closed instead of falling through to current when legacy ownership cannot be listed or a known session has exited, targeted `hasPty` discovery caches legacy ownership before later operations, real daemon adapter `listProcesses()` discovery seeds targeted `hasPty` liveness, folder and floating terminal workspace ids survive startup reconcile when valid, restored worktree-scoped and legacy/non-scoped ids do not fall back through spawn after ownership is lost or unknown, unknown or exited existing ids fail closed for routing operations, startup reconcile can dry-run orphan detection without killing live daemon sessions, and process inspection returns benign defaults for unknown ownership. It does not yet prove production startup reconcile wiring, prior-worktree aliases, or real daemon process restart behavior.

The SSH/remote provider contract now has its first executable provider/main/renderer slice. Provider observation failures are treated as unknown instead of destructive evidence: a failed SSH `listProcesses()` call does not clear previously learned ownership, and a rejected SSH `hasPty()` probe returns unknown liveness (`null`) rather than dead. The focused renderer/provider tests also assert that saved SSH sessions reattach through relay `pty.attach`, expired relay attach does not silently fresh-spawn inside the provider, deferred passphrase cancellation does not auto-reconnect, saved leaf/tab session ids are used after connection, transient deferred reattach failure preserves the saved session id without clearing pane/tab bindings or fresh-spawning, deferred SSH no-result cleanup clears the pending serializer without consuming the saved restore id, and expired deferred relay state clears stale pane/tab bindings before one fresh replacement spawn.

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/providers/ssh-pty-provider.test.ts \
  src/main/ipc/pty.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts \
  src/renderer/src/store/slices/store-session-cascades.test.ts
```

Result on 2026-07-02: 4 test files passed, 546 tests passed, duration 6.48s. Focused validation asserts store wake-hint metadata for disconnected SSH relay ids, provider attach/expired-attach behavior, main-process ownership and targeted-liveness failure semantics including async provider rejection, mocked-renderer deferred SSH attach/transient-failure/expired-relay fallback, and deferred SSH no-result cleanup that clears the pending serializer without consuming the saved restore id. It does not yet prove WSL, remote-runtime mirror polling, a live SSH relay, pending-vs-attached UI status, or real network reconnect timing.

API-surface validation after adding `pty.hasPty(id)`:

```sh
pnpm run typecheck:node
pnpm run typecheck:web
```

Result on 2026-07-02: both typechecks passed.

The output-backpressure budget gate now has a deterministic provider/IPC/renderer slice:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/daemon/daemon-stream-data-batcher.test.ts \
  src/main/ipc/pty.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts
```

Result on 2026-07-02: 3 test files passed, 469 tests passed, duration 9.35s. The focused command asserts daemon socket `write(false)`/`drain` ordering, cross-session interactive output priority, pure-backpressure cleanup, bounded daemon queued bytes, main pending renderer caps, active pending-output protection, replay/backlog slices, and ACK-gated in-flight bounds. It does not yet prove live hidden-output floods, renderer parse pressure, event-loop delay, active key latency, or full Electron perf artifacts.

Combined focused terminal/provider validation:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/daemon/degraded-daemon-pty-provider.test.ts \
  src/main/ipc/pty.test.ts \
  src/renderer/src/components/terminal-pane/terminal-dead-session-reconcile.test.ts \
  src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.test.ts \
  src/renderer/src/components/terminal-pane/pty-connection.test.ts \
  src/renderer/src/lib/resume-sleeping-agent-session.test.ts
```

Result on 2026-07-01: 8 test files passed, 625 tests passed, duration 6.55s. This was focused terminal/provider validation, not structural manifest validation.

Reliability manifest checker validation is separate:

```sh
pnpm run check:reliability-gates
```

Result on 2026-07-02: reliability gate manifest check passed for 27 gates. This validates the manifest shape and referenced files; it does not prove the registered commands cover the full terminal runtime.

The highest-risk architecture boundaries are:

- Terminal/session ownership is spread across tab PTY ids, leaf PTY ids, last-known relay ids, pending reconnect maps, deferred SSH maps, sleeping records, and provider ownership. The plan needs a derived ownership snapshot oracle for tests/logging so attach, reattach, exit, clear, hibernate, and restore can prove all authorities agree.
- Queued or pending provider sessions must count as owned. This branch now restores the pending startup and automatic resume claim bridge and covers same-session/wrong-session hook evidence, but real hook timing and repeat activation through Electron still need coverage. This is the class-level invariant motivated by #6800.
- Stale branch risk is real. The reliability branch previously lacked some protections present on fresh `origin/main`, including queued automatic agent resume claims and exact `hasPty` missing-session reconciliation. This branch has restored those two deterministic slices; the full stack still needs final rebase/retarget verification before landing.
- Main PTY ownership historically had convenient fallback behavior for unknown ownership. This branch now hardens daemon-router and degraded-provider paths so discovered legacy ownership is cached and unknown existing-session operations fail closed, but SSH/remote/diagnostic listing paths still need live coverage.
- Startup daemon reconciliation is present as a mechanism but not wired as production startup behavior. Without it, the daemon can still have a session while the adapter no longer knows it owns that session.
- Degraded daemon routing on fresh `origin/main` can fall back to local for unknown existing-looking sessions. This branch now hardens operation plus restored worktree-scoped and legacy/non-scoped spawn paths to fail closed and registers a focused provider contract, but startup reconcile, prior-worktree aliases, and real daemon restart behavior still need coverage.
- `pty:listSessions` both observes and mutates provider ownership. This branch now asserts failed SSH observation does not clear previously learned ownership and mocked deferred SSH attach/transient-failure/expired-relay fallback behaves correctly, but WSL, remote-runtime mirror polling, live SSH reconnect timing, and false-live tab behavior remain unproved.
- Resource Manager broad session inventory is now limited to popover-open and explicit management refreshes. It still needs a status/diagnostic budget proving open-popover polling is bounded with many providers and does not become a hot-path substitute.
- Boot hydration (`hydrateLocalPtyRegistryAtBoot`) is fire-and-forget, and this branch now records startup phase counters for repo/worktree enumeration, skipped remote repos, adapter/session listing, registrations/skips, duration, and failures. It can still create startup-adjacent git subprocess and daemon-listing churn across many local repos, so do not treat startup reliability as covered until those counters are budgeted in CI/runtime evidence.
- Deferred SSH restore intentionally marks a saved PTY id before actual attach. This branch now covers the mocked renderer contract for passphrase cancellation, attach after connection, transient attach failure preserving retry state, and expired relay fallback; remaining work is false-live visual state, live SSH relay timing, and duplicate-spawn prevention under real reconnect churn.
- Geometry truth is incomplete across SSH/remote paths. Requested size, renderer size, provider-applied size, shell-visible size, and the runtime mirror's parse dimensions must be separated instead of treated as interchangeable. #7192 proved the mirror can silently stay at birth dimensions while every other authority resizes, corrupting every later restore snapshot, and that mirror reflow must stay ordered with queued output writes.
- Production diagnostics are still incomplete. This branch now records compact crash breadcrumbs for explicit terminal lifecycle anomalies, but real user reports still need a bounded pane lifecycle trace for ordinary transitions and a diagnostics-bundle artifact proving those breadcrumbs/traces are included.

The lifecycle breadcrumb gate now has its first executable slice:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/terminal-lifecycle-diagnostics.test.ts
```

Result on 2026-07-02: 1 test file passed, 2 tests passed, duration 0.593s. The focused command asserts `warnTerminalLifecycleAnomaly` preserves its console warning, records a compact `terminal_lifecycle_anomaly` renderer crash breadcrumb with terminal identity/provider/PTY/reason fields, and dedupes repeated anomalies by lifecycle identity. It does not yet prove a full pane lifecycle trace buffer, diagnostics-bundle export, or forbidden-transition assertions across live Electron/provider flows.

Specific current-source evidence checked in this pass:

- Fresh `origin/main` has queued provider-session protections in `src/renderer/src/lib/resume-sleeping-agent-session.ts`: `resumeProviderSession`, `claimAutomaticAgentResume`, and `automaticAgentResumeClaimsByTabId`.
- Fresh `origin/main` has exact liveness reconciliation in `src/renderer/src/components/terminal-pane/terminal-dead-session-reconcile.ts` and the `pty:hasPty` IPC handler in `src/main/ipc/pty.ts`.
- Fresh `origin/main` still uses a single `pendingReplayData` slot in `src/renderer/src/components/terminal-pane/pty-connection.ts` (re-verified after #7133 merged; #7133 changed the same file's `applyMainBufferSnapshot` alt-screen restore path, not replay draining). This branch changes replay draining to coalesce snapshots before xterm parsing starts, queue accepted snapshots FIFO once parsing is in progress, and coalesce burst tails to the newest snapshot once the in-flight queue is full. The broader scrollback gate still needs metadata-only replay, `clearBeforeReplay`, and hidden/live-output interleaving coverage.
- Fresh `origin/main` still has `DaemonPtyAdapter.reconcileOnStartup` with the explicit note that it has no production caller yet. This branch adds a dry-run mode so future startup wiring can audit would-kill sessions before destructive cleanup, but production startup-persistence remains a real gap until wired with prior-worktree aliases or tracked as an accepted gap with a gate.
- Fresh `origin/main` still lets `DegradedDaemonPtyProvider.providerFor()` fall back to local when an existing-looking session id is unmapped and not rediscovered by `hasPty`. This branch changes existing-session operation paths and restored worktree-scoped plus legacy/non-scoped spawn paths to fail closed, adds contract tests, and makes real daemon adapter `listProcesses()` discovery seed targeted `hasPty` liveness. Startup reconcile wiring and live daemon-restart validation are still required before the full provider lifecycle is covered.
- Fresh `origin/main` let the daemon router spawn an unknown existing `sessionId` on the current daemon when routing cache/discovery missed its real owner. This branch now probes/discovers all adapters first, requires `isNewSession` for intentional replacement after an authoritative exit event, and fails closed if legacy ownership cannot be listed or the known id has exited, so a stale existing id cannot silently mint over another daemon's history on current.
- Fresh `origin/main` let canonical daemon-worktree restores treat a non-minted stale/local PTY id as restorable metadata. This branch now rejects non-minted restored ids when the workspace owner is canonical (`repo::path`, `folder:<id>`, or `global-floating-terminal`), clears the stale pane/tab binding, and fresh-spawns instead of calling daemon reattach or attaching that stale id. Shared parsing also recognizes folder and floating minted ids so startup reconcile does not falsely reap valid non-repo terminal sessions.
- Fresh `origin/main` still lets `pty:listSessions` rebuild provider ownership while SSH listing failures become empty lists. This branch adds store/main/provider/renderer contracts proving disconnected SSH relay ids are retained as deferred reconnect metadata and sidebar wake hints rather than attached PTY proof, failed SSH observation does not clear previously learned ownership, `hasPty` failure is unknown, saved SSH sessions attach through relay `pty.attach`, deferred passphrase cancellation does not auto-reconnect, transient deferred reattach failure preserves the saved session id, deferred SSH no-result cleanup clears pending serializer state without consuming retry metadata, and expired deferred relay state clears stale pane/tab bindings before one fresh replacement spawn. Live SSH, WSL, remote-runtime mirror polling, false-live visual state, and real reconnect timing remain unproved.
- Fresh `origin/main` has strong Windows/unit coverage around ConPTY packaging, shell resolution, size validation, keyboard reset, complex-script classification, and Windows PTY compatibility, but the real Windows Electron/ConPTY path is still not covered as a reliable PR gate.
- Fresh `origin/main` still exposes global `pty:listSessions`; this branch now also uses targeted `hasPty` for visibility/input liveness, but gates should keep typing, focus, tab switch, visibility resume, resize, and render paths from reintroducing broad daemon/provider listing.
- Fresh `origin/main` has main-to-renderer ACK/backpressure, renderer output-scheduler caps, terminal perf scripts, and a daily/manual terminal perf workflow. This branch adds daemon stream batcher assertions that socket `write(false)` pauses further stream events until `drain`, flush-immediate output from another session drains before unrelated background backlog, global cleanup clears clients that only have backpressured writes, and queued daemon stream bytes stay bounded by preserving priority output plus the newest tail under sustained pressure; it also caps main pending renderer output per PTY and in total, trims background pending output before active pending output under total pressure, and asserts `seq`/`rawLength` metadata stays correct for the surviving tail. Live hidden-output pressure, active input latency, and full Electron perf artifacts remain unproved.
- Fresh `origin/main` has binary runtime/mobile terminal stream caps, but the legacy JSON subscription path has weaker buffering/backpressure guarantees. Either gate both paths or explicitly deprecate/accept the JSON gap.

Existing E2E/perf tests that should be reviewed for promotion:

- `tests/e2e/daemon-slow-init-pty-gate.spec.ts`: strong daemon live-session restore signal; already has a tight user-visible invariant.
- `tests/e2e/daemon-live-session-preservation.spec.ts` and `tests/e2e/daemon-slow-health-check-preservation.spec.ts`: likely useful daemon liveness/preservation gates after oracle and flake review.
- `tests/e2e/terminal-typing-latency.spec.ts`, `tests/e2e/terminal-codex-local-typing-latency.spec.ts`, and `tests/e2e/terminal-history-size-typing-latency.spec.ts`: useful perf signals, but should be tied to stable budgets and artifacts before blocking promotion.
- `tests/e2e/terminal-output-scheduler.spec.ts`, `tests/e2e/artificial-opencode-terminal-load.spec.ts`, and hidden-pressure scenarios: useful for output/backpressure, but should become metric-gates rather than visual-only broad E2Es.
- `tests/e2e/terminal-hidden-tui-visual-restore.spec.ts`, `tests/e2e/terminal-document-visibility-webgl-recovery.spec.ts`, and `tests/e2e/terminal-tab-switch-visual-restore.spec.ts`: useful rendering recovery coverage; must keep deterministic text/buffer oracles and limit screenshots to diagnostics.
- `tests/e2e/terminal-long-table-scroll-restore.spec.ts` and `tests/e2e/terminal-raw-emoji-table-scroll-restore.spec.ts`: useful scrollback/rendering regression evidence, but they contain timed waits and should be reviewed before blocking promotion.
- `tests/e2e/ssh-localhost.spec.ts`, `tests/e2e/ssh-docker-relay-perf.spec.ts`, and SSH Codex replay/reconnect specs: useful SSH coverage, but should be separated into deterministic provider contracts plus a small number of environment-dependent live SSH soaks.
- `tests/e2e/terminal-windows-shell-paste-ownership.spec.ts` and Windows env/icon tests: useful Windows path coverage, but not a substitute for a Windows ConPTY live liveness gate.

Promotion split for existing E2Es:

- Promote after soak: a smaller derivative of `terminal-typing-latency.spec.ts` as the live local PTY input/output gate.
- Promote after soak: daemon preservation specs, especially slow-init and stale launch identity, as daemon warm-reattach gates.
- Promote targeted: paste ownership tests where the oracle is visible output plus exactly-one PTY write.
- Keep in soak/nightly: artificial OpenCode load, terminal scale perf report, hidden real-PTY pressure, and SSH Docker perf.
- Keep as release evidence: raw emoji/golden rendering, long-table rendering, WebGL recovery, and Codex/OpenCode artifact repros.
- Rewrite before blocking: column desync specs need resize-applied acknowledgement or an in-PTY `SIGWINCH` marker instead of post-resize sleeps.
- Rewrite before blocking: SSH Codex artifact repros and headful dead-terminal repros need deterministic fixtures/events instead of long waits and screenshots as primary proof.

The first live PTY gate is deliberately small:

- File: `tests/e2e/terminal-live-pty-liveness.spec.ts`.
- Command: `pnpm run ensure:electron-runtime && npx playwright test tests/e2e/terminal-live-pty-liveness.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1`.
- Invariant: a newly opened local terminal has one active PTY id listed exactly once, accepts real keyboard input through focused xterm, delivers process output visibly, keeps the same PTY id through repeated workspace hide/restore cycles, accepts input after restore, applies an actual size change, and exits without leaving a stale binding.
- Oracle: start a deterministic Node raw-mode probe, wait for `LIVE_PTY_READY_<runId>`, require the active PTY id to appear exactly once in `pty:listSessions`, type through `.xterm-helper-textarea`, require ordered per-key markers in serialized terminal content, switch to another worktree and back twice, require the active pane to keep the original PTY id, type again after each restore, resize and require `pty:getSize` to change plus a matching process-visible size marker, then exit the probe and shell and require the old PTY id to disappear from `pty:listSessions`.
- Wait rule: no blind sleeps. Wait only on PTY binding, active worktree changes, ready marker, key markers, resize marker, and list-session absence.
- Budget: target p95 under 75s on Linux including e2e build/setup, hard test timeout 90s. Start blocking on Linux only after soak; run macOS/Windows nightly until each platform has its own history.
- Failure artifacts: PTY id, provider classification, pid if available, size snapshots, key latencies, final `listSessions`, trace, and screenshot.
- Red/green proof: intentionally break xterm focus, PTY write forwarding, resize forwarding, and exit cleanup in separate local runs and confirm the gate fails for each class.
- Local run on 2026-07-02: 1 Playwright test passed in 58.6s total, with an 8.6s test body, on this macOS worktree. This is one green local run for the local live PTY path, not enough flake/runtime history for blocking promotion.

## Gate Coverage Matrix

This is the intended shape after rebasing the stack. The first two columns are what we have now; the last two are what must be added or promoted before the plan earns broader reliability claims.

| Reliability class | Existing evidence | Gap | Next gate or action |
| --- | --- | --- | --- |
| Stale liveness snapshots closing newer PTYs | `terminal-session.snapshot-freshness`; deterministic unit coverage | No full Electron tab-survival/input echo proof | Add `terminal-platform.live-pty-liveness` and keep snapshot gate as lower-layer guard |
| Provider-session replay ownership | `agent-session.provider-ownership`; renderer state tests; queued/pending resume claim proof; bounded queued-claim index proof; same-session and wrong-session hook proof | Needs real Electron repeated activation/hook timing and bounded hook/status scan assertions if those grow | Add Electron activation proof |
| Exact PTY liveness | Fresh main has targeted `hasPty` path | Current branch must not lose it; provider failures must be unknown, not dead | Rebase/restore exact liveness reconciliation and register it as a gate |
| Store/session ownership coherence | Many focused tests touch pieces | No single derived oracle across tab, leaf, relay, reconnect, deferred SSH, and sleeping maps | Add ownership snapshot helper for tests/logging |
| Terminal lifecycle diagnostics | `terminal-observability.lifecycle-breadcrumbs` now records compact anomaly breadcrumbs into crash diagnostics | No full pane lifecycle trace buffer or diagnostics-bundle artifact proof | Add bounded trace buffer and bundle artifact test |
| Xterm addon/search/WebGL containment | `xterm-addon.boundary-containment`; deterministic core addon load, link-provider, search, and WebGL containment tests; #7054 hidden TUI product hardening | Needs live Electron typed input/output survival after addon failure, and WebGL dispose/reset throw coverage across active/hidden/resumed panes | Add focused component/live input echo follow-up; promote hidden TUI E2E after flake review |
| Visible terminal geometry | #7006 renderer/provider-style gate; #7192's merged mirror-resize and reflow-ordering red tests on main | SSH/remote and shell-visible truth not fully covered; mirror-geometry slice unregistered until rebase | Add live PTY size readback and provider-applied-size contract; register #7192's mirror-authority tests |
| Persisted session upgrade | #7007 fixture gate | Needs broader old-version corpus and daemon/SSH cases | Build immutable fixture corpus with startup timing |
| Live local PTY lifecycle | `terminal-platform.live-pty-liveness` now has a focused Electron Playwright slice covering local spawn, single active PTY listing, xterm input, PTY output, repeated workspace hide/restore, actual resize propagation, and cleanup | Needs flake/runtime history, red-green evidence, tab switch, scrollback after restore, app restart persistence, and non-local provider coverage | Promote first slice after soak; add tab-switch/scrollback/restart follow-ups |
| Windows ConPTY lifecycle | Recent fixes on main, some unit/platform logic | No required Windows live gate for ConPTY echo/resize/cursor/CJK/IME | Add `terminal-platform.windows-conpty-liveness` |
| Windows keyboard reset | Unit coverage and recent #6999/#6858 fixes | No live proof that Enter/Backspace/Arrow return to normal after agent/TUI exit | Add `terminal-input.windows-conpty-keyboard-reset` |
| Windows CJK/repaint | Complex-script and compatibility tests plus recent CJK repaint fixes | No Windows visual/pixel oracle for wide-glyph in-place redraws | Add `terminal-render.windows-cjk-repaint` |
| Windows shell parity | Shell resolution unit coverage and packaging fixes | No local-vs-daemon parity gate for PowerShell 5/7, cmd, Git Bash, WSL, startup command delivery | Add `terminal-shell.windows-resolution-parity` |
| Input latency/perf | Existing terminal perf scripts and typing-latency spec | Not registered, not tied to budgets/owners/promotion | Add `terminal-performance.input-throughput` |
| Hot interaction listing | Recent #7002 fix, targeted `hasPty` path, deterministic visibility/input/resize no-listing assertions, light tab/active-state resume no-provider-fanout assertions, and closed Resource Manager broad-listing avoidance | No count gate proving `pty:listSessions` stays out of raw focus/workspace-switch/render/high-session Electron scenarios; open Resource Manager polling still needs an explicit budget | Extend `terminal-performance.no-hot-list-sessions` |
| Daemon stream backpressure | Batching/chunking plus new batcher contract proof for `write(false)`/`drain`, cross-session flush-immediate drain priority, pure-backpressure cleanup, and bounded queued tails | No live hidden-output flood proof or active input latency artifact | Extend `terminal-performance.output-backpressure-budget` |
| Renderer/main ACK and backlog | Main ACK gates, renderer scheduler caps, focused unit coverage, and bounded main pending tails exist | No live metric artifact tying hidden restore, active key latency, queued chars, and dropped backlogs to promotion | Extend `terminal-performance.output-backpressure-budget` |
| Runtime/mobile terminal stream | `terminal-runtime.mobile-stream-budget`; runtime-RPC tests assert mobile initial snapshot <=512KB, requested binary snapshot <=2MB, pending live output <=256KB while snapshot loads, output frames <=48KB, output coalescing, abort cleanup, and stale resize re-stream suppression | Legacy JSON path parity/deprecation is undecided | Decide/gate/deprecate JSON fallback |
| Store/git hot paths around terminal changes | Perf/git-crash skills exist; git status limits/coalescing exist; `terminal-performance.store-and-git-hot-paths` now has a boot-hydration counter slice | No Electron count gate for terminal-adjacent store projection, git status, focus, typing, tab/workspace switch, render, or high-session provider fanout | Extend `terminal-performance.store-and-git-hot-paths` with interactive counters |
| IME and synthetic input | Input forwarding code and scattered coverage | No representative matrix or byte/cell oracle | Add `terminal-input.ime-and-synthetic-forwarding` |
| Daemon degraded/startup provider contract | Mechanisms exist; daemon slow-init E2E helps | Startup reconcile is unwired; degraded fallback needs fail-closed/probe proof | Add daemon degraded and startup reconcile contract gates |
| SSH/remote restore and mirror polling | SSH localhost and remote fixes exist; this branch has store/provider/main/renderer proof for deferred SSH wake metadata, SSH attach, listing failure, deferred attach, passphrase cancellation, transient deferred reattach failure, and expired deferred relay fallback | Remote mirror polling, live SSH relay behavior, false-live visual state, pending-vs-attached UI status, and real reconnect timing remain unproved | Add live SSH soak and remote mirror polling gates |
| WSL restore and launch identity | `terminal-provider.wsl-restore-contract` is now registered as a first-class gap | No WSL provider contract or live Windows WSL smoke yet proves cwd/path identity, startup command delivery, targeted liveness, or restore ownership | Add deterministic WSL provider contract, then one focused Windows WSL smoke |
| Scrollback/replay restore | Recent #7012 fix, long-table restore coverage, this branch's remote replay ordering proof, #7133's merged alt-only-clear tests, and #7173's merged ordered-seq interleaving and session-revival tests on main | Normal-buffer clear semantics and metadata-only replay still need deterministic lower-layer proof; the merged #7133/#7173 tests are unregistered until rebase | Add `terminal-output.scrollback-restore` as a dirty-state exactness contract, seeded with #7133's and #7173's tests |
| Renderer/mirror parser parity | #7148 (merged 2026-07-02) fixed the first known width divergence; its red-green width test exists on main | Parser configs can still drift silently on any axis besides widths; no parity gate command is registered | Add `terminal-mirror.parser-parity` built on the shared `terminal-unicode-provider.ts`/`pane-terminal-options.ts` seams |
| Post-restore convergence detection in production | Anomaly-breadcrumb machinery exists in this branch | Nothing measures renderer-vs-mirror divergence after real restores; #7133-class corruption stays silent until a user notices | Add `terminal-observability.restore-convergence-selfcheck` probe plus telemetry |
| Stale pixels after reveal (render-level) | #7133's reveal hardening and the live repro harness's refresh-repair oracle | Buffer oracles are blind to buffer-clean, pixels-stale variants by definition | Add `terminal-render.pixel-refresh-repair` to the release-blocking terminal-rendering-golden suite |

## Convergence Oracles And Escape Detection

The #7133 saga is the design input for this section. One user-visible symptom — stale terminal frames on worktree return — decomposed into five distinct mechanisms: the skipped alt-screen clear (#7133 primary fix), the WebGL render-model fossil (#7133 hardening), the daemon mirror unicode width divergence (#7148), the stale hidden-chunk ordering hole with seq-restart data loss (#7173), and desktop resizes never reaching the runtime mirror (#7192). None of the three was predictable in advance, and seventeen faithful fresh-window repro attempts missed the class because the bugs only exist in dirty, long-lived pane states. Mechanism-enumeration testing cannot catch this family. Layer-convergence assertion can.

Orca holds four copies of what a terminal shows: the PTY application's intended screen, the main-process headless mirror buffer, the renderer xterm buffer, and the WebGL-rendered pixels. Every bug in this family is two adjacent copies silently disagreeing. The strategy is two layers that map to the program's two goals — catching issues nobody predicted, and catching regressions to issues already fixed.

Catch novel escapes:

1. `terminal-observability.restore-convergence-selfcheck`: after every hidden-to-visible reveal settles — whether or not a restore was triggered — compare a bounded row-hash sample of the renderer buffer against the current main-mirror state; on mismatch, record a compact content-free `terminal_lifecycle_anomaly` breadcrumb (machinery already in this branch) and count it in telemetry. Per-reveal scope is load-bearing: #7173's frozen-output variant restores faithfully and then silently drops later hidden output, so a restore-scoped probe would never fire. This turns silent corruption into a measurable signal — #7133 and #7173 would have appeared in anomaly counts weeks before the user reports — and after each fix the anomaly rate is the in-production regression detector. Budget: one bounded comparison per reveal, no polling, no content capture beyond hashed row samples.
2. `terminal-render.pixel-refresh-repair`: the render-level variant is invisible to every buffer oracle by definition (buffer clean, pixels stale). The content-independent oracle: screenshot the revealed pane, force a full model-invalidating repaint, screenshot again; a material diff means something rendered stale, whatever the mechanism. Productize the existing live repro harness with this oracle plus a JS-level render-model-vs-buffer comparison, and land it in the release-blocking `terminal-rendering-golden` suite that `release-cut.yml` already runs against every release tag. Use nightly runs only as the interim phase to stabilize the per-platform diff threshold; golden-set membership is what makes "the next release does not ship this class" directly checkable.
3. Session-corpus replay: record real agent-session byte streams (a Claude run is exactly the #7133 shape — banner, prompt echo, final frame with blank regions) as fixtures and replay them through the hide/skip/restore machinery under the convergence oracles. Real corpora contain escape-sequence conjunctions nobody writes by hand. This is fixture strategy for the gates above, not a separate gate.

Catch regressions to known fixes:

4. `terminal-mirror.parser-parity`: feed identical byte corpora to the renderer xterm configuration and the main headless mirror and assert cell-identical buffers, with both parsers constructed from one shared configuration module. #7148's divergence (Unicode 11 + ZWJ in the renderer, default width tables in the mirror) existed since the mirror was born and was catchable by a millisecond-scale unit test; this gate also blocks the next one-sided config drift.
5. The dirty-state restore exactness contract as `terminal-output.scrollback-restore`'s command: apply snapshots onto adversarially dirty panes and assert the resulting buffer exactly equals the snapshot frame. Exactness is load-bearing — presence-of-marker oracles pass on merged frames. Seeded with #7133's merged alt-only-clear tests and #7148's positioned-overwrite width oracle.
6. Manifest registration of every escape: each fixed escape's red-green test becomes gate evidence, and per the Operating Rules the fix PR must also strengthen the relevant convergence oracle, so each escape permanently shrinks the space for the next one.

Seam placement is part of the design: convergence must be asserted at every adjacent pair of copies, not at one seam. #7192 proved this the hard way — a renderer-vs-mirror check is blind to corruption inside the mirror itself, because the restore is perfectly faithful to a corrupted source. That is why the geometry gate owns the runtime mirror's dimensions and reflow ordering as a first-class size authority, upstream of the seam this section's self-check watches.

The honest limit stands: this shrinks the escape space rather than zeroing it. The first four mechanisms in the saga are caught by items 1, 2, 4, and 5 without predicting any of them; the fifth (#7192) escaped every renderer-side oracle as originally specced and was closed by adding the mirror to the geometry authority list — evidence that the escape-driven loop (item 6) is not optional. The three new gates and the strengthened `terminal-output.scrollback-restore` entry are registered in the manifest as `protection: "none"` gaps, so the checker, factory reviews, and this plan cannot claim them as coverage before their commands exist.

## Immediate Fix Candidates

These are the concrete pieces to prioritize before declaring the plan implemented:

Three mechanical prerequisites gate everything below:

- Materialize the split: commit each working-tree slice to its owning branch per the file assignment in the PR Split Plan, reset the diverged child branches (#7004, #7005, #7006, #7008) from the worktree versions of their files, and push. Until then, every evidence run in this plan and in the manifest refers to unreproducible state.
- During the rebase, run the testFiles-vs-fresh-main audit and fix the confirmed #6949 WebGL rename by adopting `terminal-webgl-atlas-recovery.test.ts` and evaluating `pane-webgl-context-recovery.test.ts` and `pane-webgl-renderer.test.ts` for the containment gate.
- Open the aggregated non-blocking `reliability-gates` CI job so promotion evidence starts accruing with machine provenance.

1. Rebase or retarget the existing reliability PR stack onto fresh `origin/main`, then verify the stack still contains queued automatic resume claims and exact `hasPty` missing-session reconciliation. This branch has restored both deterministic slices, but final stack verification is still required.
2. Extend the provider-session ownership test from the current queued/pending, bounded-index, same-session hook, and wrong-session hook proof to a real Electron repeated-activation test, plus bounded-work assertions for any new hook/status scans.
3. Add or restore exact liveness tests: `hasPty(id) === false` tears down only the matching local PTY, while `true`, `null`, rejection, SSH/remote unknown states, and stale pre-bind responses do not close panes.
4. Add a small derived terminal ownership snapshot helper for tests and diagnostics. It should report whether each live PTY is represented once by the intended tab/leaf and absent from stale maps after attach, reattach, exit, clear, hibernate, and restore.
5. Keep the replay FIFO/burst fix and tests in the stack, rebased over #7133's alt-clear restore preamble in the same file. This branch now asserts that multiple replay notifications arriving during an async drain cannot overwrite one another, cannot reorder accepted replay snapshots, and cannot grow an unbounded replay queue under bursty snapshots; remaining replay work is normal-buffer clear semantics (alt-screen clear landed in #7133), metadata-only replay, and hidden/live-output interleaving.
6. Wire `DaemonPtyAdapter.reconcileOnStartup`, or explicitly create a provider-contract gate and accepted gap if wiring is not safe yet.
7. Keep the degraded daemon fail-closed contract in place and extend it to startup/restart coverage. This branch now prevents unknown existing ids from silently routing operation calls or restored worktree-scoped and legacy/non-scoped spawn calls to fallback; the remaining work is production startup reconcile, prior-worktree aliases, and live daemon-restart validation.
8. Keep the daemon-router targeted-discovery fix in place. This branch now caches ownership discovered by `hasPty()` before later write/resize-style operations and fails closed for operations on unknown existing session ids, preventing legacy-daemon sessions from silently routing to the current daemon.
9. Extend provider listing failure contract tests. This branch now asserts disconnected SSH relay ids are retained as deferred reconnect metadata and sidebar wake hints rather than attached PTY proof, a rejected SSH listing does not clear previously learned ownership, thrown SSH `hasPty` is unknown, provider expired attach does not silently fresh-spawn, deferred SSH passphrase cancellation does not reconnect, deferred attach uses saved session ids, transient deferred reattach failure preserves retry metadata instead of fresh-spawning, and expired deferred relay fallback clears stale pane/tab bindings before one fresh spawn. Remaining work is empty-but-ambiguous provider snapshots, WSL, remote-runtime mirror polling, live SSH relay timing, false-live visual state, pending-vs-attached UI status, and pane-close behavior.
10. Extend the new lifecycle anomaly breadcrumbs into a bounded structured lifecycle trace outside E2E-only mode for reattach, expired sessions, provider-list failure, unknown ownership, fallback routing, replay, and terminal input recovery.
11. Extend the hot-interaction listing count gate. The targeted `hasPty`, resize-on-resume, light tab/active-state resume, and closed Resource Manager polling slices are implemented; next it should prove `pty:listSessions()` calls are zero during raw focus, workspace switch, render, high-session Electron scenarios, and separately budget open status/diagnostic polling.
12. Add a cheaper Resource Manager session-status path or an explicit budget for open-popover `pty:listSessions()` polling. The closed-popover poll is removed, but the visible Resource Manager inventory still fans out to providers and mutates ownership, so it should have a measured ceiling.
13. Budget the new startup hydration counters for `hydrateLocalPtyRegistryAtBoot` in CI/runtime evidence, including repo/worktree enumeration count, git subprocess count proxy, daemon session-list duration, and confirmation that no startup-critical path awaits the scan.
14. Extend the output backpressure proof. The daemon stream batcher now pauses after `write(false)`, prioritizes flush-immediate output from another session ahead of unrelated background backlog on `drain`, clears pure-backpressure queues on global cleanup, bounds queued stream bytes, and resumes on `drain`; main pending renderer output is capped per PTY and in total. Next, hidden-output floods and active key latency need metric artifacts under the perf budget.
15. Add Windows platform gates rather than relying on Linux/macOS live PTY evidence: ConPTY liveness, keyboard reset, CJK repaint, shell resolution parity, and IME/native-text forwarding.
16. Decide whether the legacy JSON runtime terminal subscribe path is supported. If supported, gate its snapshot/live-output byte caps; if not, mark it as an accepted gap with a deprecation path.
17. Implement the dirty-state restore exactness contract as `terminal-output.scrollback-restore`'s first command, seeded with #7133's merged alt-only-clear tests and #7173's ordered-seq interleaving and session-revival tests: apply snapshots onto already-alt-screen panes with stale content in cells the new frame leaves blank, include revived sessions with restarted PTY seq counters in the dirty-state matrix, and assert exact buffer equality.
18. Implement the parser-parity seed during the rebase, now that #7148 has merged: register `headless-emulator-unicode-width.test.ts` plus a shared parser-construction assertion over `terminal-unicode-provider.ts` and `pane-terminal-options.ts` as `terminal-mirror.parser-parity`'s first command. The test file exists on fresh main but not at this branch's stale merge-base, so the command cannot be registered before the rebase.
19. Implement the per-reveal convergence self-check behind the existing anomaly-breadcrumb machinery — comparing the renderer buffer against current mirror state on every reveal, not only after restores, with a strict per-reveal budget and no content capture — and productize the stale-render repro harness into `terminal-render.pixel-refresh-repair` targeting the release-blocking terminal-rendering-golden suite.
20. Register #7192's merged mirror-geometry red tests as the mirror-authority slice of `terminal-geometry.visible-convergence` during the rebase, covering both accepted-resize fan-out to the runtime mirror and reflow-vs-queued-output ordering.

Next gates to add before claiming broad terminal reliability coverage:

1. `terminal-platform.live-pty-liveness`: first focused Electron/live-PTY slice is implemented for local Linux/macOS-style terminals. One local macOS run asserts bind, single active PTY listing, focus, keyboard input, PTY echo, repeated workspace hide/restore of the same PTY, post-restore input, actual size propagation, and exit cleanup. Follow up with scrollback-after-restore, tab switch, app restart, and non-local providers before broad live-terminal claims; keep it `experimental` until it has flake/runtime and red-green evidence.
2. `terminal-platform.windows-conpty-liveness`: Windows-specific gate for ConPTY spawn/activation, PowerShell resolution, cursor/rewrite repaint, CJK/IME bytes, and no stuck `stale_bootstrap`. Use lower-level provider contracts where possible and one focused Windows Electron smoke for the real ConPTY path.
3. `terminal-input.windows-conpty-keyboard-reset`: Windows local ConPTY gate proving Enter, Backspace, Arrow, paste, and ordinary shell submission behave normally after an agent or TUI exits. Oracle should include PTY input logs proving stale Kitty/CSI-u mode is not still applied to standard keys.
4. `terminal-render.windows-cjk-repaint`: Windows local ConPTY wide-glyph redraw gate. Oracle should combine xterm buffer/text evidence with screenshot/canvas/pixel evidence and a bounded refresh count.
5. `terminal-shell.windows-resolution-parity`: local and daemon providers must resolve equivalent shell path, args, cwd, env, startup command delivery, and fallback behavior for PowerShell 5/7, cmd, Git Bash, WSL, and missing `pwsh`.
6. `terminal-performance.input-throughput`: non-blocking perf gate for typing latency, hidden-output pressure, renderer CPU, terminal output throughput, resize churn, and store subscriber work. This should be metric-based, not screenshot-based.
7. `terminal-performance.no-hot-list-sessions`: deterministic count gate proving `pty:listSessions()` is not called from typing, focus, tab/workspace switch, visibility resume, resize, render, or per-pane liveness paths.
8. `terminal-performance.daemon-stream-backpressure`: provider/daemon contract gate proving daemon socket writes respect backpressure under output floods and do not starve active input.
9. `terminal-performance.output-backpressure-budget`: main-to-renderer ACK and renderer scheduler budget gate. Suggested ceilings: peak renderer in-flight bytes <=8MB total, <=512KB per PTY plus active reserve, renderer queued chars <=2MB, dropped renderer backlogs 0 in normal perf scenarios, and hidden restore <=1000ms.
10. `terminal-runtime.mobile-stream-budget`: runtime/mobile stream gate proving binary terminal snapshots stay <=512KB mobile or <=2MB requested, live pending output stays <=256KB while snapshot loads, chunks stay <=48KB, and batches stay <=64KB.
11. `terminal-input.ime-and-synthetic-forwarding`: representative IME/input matrix with deterministic byte/cell oracles at the lowest reliable layer, plus platform-specific manual/soak coverage where real IMEs are required.
12. `terminal-provider.remote-daemon-contract`: provider contract for daemon degraded spawn, SSH/remote unknown liveness, mirror polling, reconnect, and path/cwd authority.
13. `terminal-provider.wsl-restore-contract`: Windows WSL provider contract proving host/guest cwd identity, shell launch args, startup command delivery, targeted liveness semantics, and restore ownership, followed by one focused live WSL smoke.
14. `terminal-output.scrollback-restore`: deterministic scrollback/snapshot/replay gate for hidden output, restore, clearing, and no cross-tab or stale-output overlap. Seed it with #7133's merged assertions — the alt-only clear preamble written before alt-screen snapshot data (and no `3J`) in `pty-connection.test.ts`, plus the reveal-repaint ordering tests — then extend to normal-buffer clear semantics, metadata-only replay, and hidden/live-output interleaving. #7133's buffer-merge escape (pre-hide frame bleeding through blank cells) is the motivating regression for this gate.
15. `terminal-capability.startup-color-query`: startup OSC 10/11 replies are answered out of band at startup only, do not leak into shell/renderer streams, and ordinary OSC color queries remain renderer-handled.
16. `terminal-mirror.parser-parity`: renderer xterm and the main headless mirror parse identical byte corpora into cell-identical buffers, with both parsers constructed from one shared configuration module. Seed with #7148's merged width test (`headless-emulator-unicode-width.test.ts`) plus a shared-construction assertion over `terminal-unicode-provider.ts` and `pane-terminal-options.ts`; extend with recorded agent-session corpora.
17. `terminal-observability.restore-convergence-selfcheck`: production per-reveal probe comparing a bounded row-hash sample of the renderer buffer against current main-mirror state — on every reveal, not only after restores, because #7173's frozen-output variant never triggers another restore — recording deduped content-free anomaly breadcrumbs and telemetry counts. This is the in-production escape detector for the whole restore family; corruption upstream of the mirror itself is owned by the geometry gate.
18. `terminal-render.pixel-refresh-repair`: content-independent refresh-repair oracle (screenshot, force a model-invalidating repaint, screenshot, bounded diff) plus a render-model-vs-buffer comparison, productized from the existing stale-render repro harness into the release-blocking `terminal-rendering-golden` suite; nightly runs only until the diff threshold is stable.

Specific near-term hardening before promotion:

- #7008 now includes a bounded queued-claim assertion plus same-session and wrong-session hook cases for provider-session ownership checks. It should still be followed by a real Electron repeated-activation proof and any additional bounded-work assertions if hook/status ownership scans grow.
- Each gate PR should keep its residual gaps in the PR description and manifest until a real follow-up gate removes them. Do not let a green lower-layer gate imply live Electron, SSH, WSL, Windows ConPTY, or IME coverage.

Promotion rule for these additions is unchanged: do not make any of them blocking until they have red/green proof, stable runtime history, zero unexplained flakes in the promotion window, a clear owner, and a demotion rule. A non-blocking gate is useful evidence and documentation; it becomes protection only after promotion criteria are met.

## Goal

Prevent the recent terminal, tab, session, startup, provider, and performance regressions from escaping again by turning each high-risk reliability class into a small executable gate with explicit maturity, owner, runtime budget, flake history, and promotion evidence.

This plan is broad in scope but staged in rollout. The first milestone exercises the operating model end to end; later milestones add live Electron, Windows ConPTY, SSH/remote, daemon, IME, scrollback, and performance gates without turning the suite into noisy sprawl.

## Operating Rules

- Add gates only when they protect a named invariant tied to a real issue, PR, or accepted gap.
- Prefer deterministic unit or provider-contract tests over Electron UI tests when the lower layer proves the user-visible invariant.
- Never promote a gate to blocking until it has red/green evidence, stable runtime evidence, and a named demotion rule.
- Keep stress/torture runs non-blocking unless they have deterministic oracles and flake history.
- Include a performance or crash-safety budget whenever the protected change touches terminal throughput, hidden panes, persistence, startup, polling, subprocesses, git/worktree scans, SSH, WSL, or Windows paths.
- Restore, replay, reattach, and snapshot gates must start from adversarially dirty initial states — already-alt-screen panes, stale content occupying cells the new frame leaves blank, scrollback present, wide/emoji glyphs — never only fresh terminals. Fresh-state-only testing is why the #7133 class survived seventeen faithful repro attempts.
- Restore and replay oracles must assert frame exactness or stale-content absence. Marker-presence oracles pass on merged frames and are not acceptable correctness evidence for restore paths.
- Every escaped terminal bug's fix PR must ship both the narrow mechanism regression test and a strengthening of the relevant convergence oracle (parser parity, restore exactness, convergence self-check, or pixel refresh-repair), so each escape permanently shrinks the space for the next one.

## Milestone 1

Milestone 1 creates the reliability-gate loop with the two highest-leverage escaped classes:

1. `terminal-session.snapshot-freshness`
   A stale local/daemon liveness snapshot cannot close a newer PTY binding.

2. `agent-session.provider-ownership`
   Workspace activation, restore, sleep, hibernate, dedupe, clearing, or reconnect code cannot replay or resume a provider session already owned, queued, pending, or live in the workspace.

Both gates already have targeted tests in the repo. Milestone 1 makes them reviewable factory artifacts by registering their invariant, command, owner, maturity, known gaps, and promotion criteria in `config/reliability-gates.jsonc`.

## First Commands

Run the structural manifest check:

```sh
pnpm run check:reliability-gates
```

Run the first two gate tests:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/terminal-pane/terminal-dead-session-reconcile.test.ts \
  src/renderer/src/lib/resume-sleeping-agent-session.test.ts
```

Run the existing terminal perf report gate before promoting terminal lifecycle gates to blocking:

```sh
pnpm run test:e2e:terminal-perf:scale:report
```

## Promotion Criteria

A gate can move from `experimental` to `soak` when:

- it is registered in the manifest;
- it has a deterministic oracle with no blind sleeps;
- it has a cheap command that can run repeatedly;
- it names the failure artifact reviewers should inspect;
- it has a clear owner and demotion rule.

A gate can move from `soak` to `blocking` when:

- it has red/green evidence against the old behavior, a regression fixture, or an intentionally broken variant;
- it has at least 100 consecutive passing soak runs or 14 days of required-platform CI history, whichever is more appropriate for the gate;
- that history comes from the aggregated `reliability-gates` CI job with machine-recorded results (see Evidence Provenance And CI Wiring), not from hand-entered local runs;
- p95 runtime is within the manifest budget;
- there are zero unexplained flakes in the promotion window;
- any required perf/git-crash budget has measured evidence.

For visual and live release-assurance gates, `blocking` means membership in the release-blocking `terminal-rendering-golden` suite that `release-cut.yml` runs against every release tag — the existing golden rail, not a new checkpoint mechanism, and never PR-blocking. Deterministic unit and contract gates stay on the PR path, where catching a regression is strictly cheaper than catching it at release time.

The manifest also allows `accepted-gap` for explicitly deferred reliability work with a named owner and `deprecated` for gates superseded by a stronger invariant or removed product surface. Those levels should stay visible in the manifest so factory review can distinguish intentional gaps from missing coverage.

## Factory Contract

`brennan-yolo-lite`, `review-code`, `perf`, and `git-crash-perf` should treat the manifest as the source of truth.

For any PR touching a P0-capable surface, the agent or reviewer should:

- identify the touched reliability class;
- name the matching manifest gate or accepted gap;
- run the gate command or explain why it does not apply;
- require a new manifest entry when the PR introduces a new reliability class;
- invoke `perf` or `git-crash-perf` when the touched surface matches their risk scope.

## Evidence Provenance And CI Wiring

Hand-entered evidence is the weakest link in this plan: the checker validates metadata shape, but nothing yet proves a registered command actually ran against the code it claims to cover. Reliability gates become protection only when they run automatically, against pushed commits, with recorded history. Requirements:

1. Every `evidenceRuns` entry must record the pushed commit SHA it ran against. A run against uncommitted working-tree state is a development note, not promotion evidence; it must be re-run and re-recorded once the owning PR's branch is pushed. All evidence runs currently in the manifest predate the split and must be refreshed this way.
2. Add one aggregated non-blocking `reliability-gates` CI job that runs `check:reliability-gates` plus every command-backed gate command, and uploads a machine-readable per-gate result artifact (gate id, command, result, duration, commit SHA, runner platform). Run it nightly and on PRs that touch terminal/session/provider/startup paths. Because every gate command except the live Playwright slice is a focused vitest run measured in seconds (a combined run of all 28 unit-layer gate test files completed in 10.2s with 928 tests on 2026-07-02), the job's cost is dominated by setup, not by gate count.
3. Promotion to `active`/blocking requires history from that CI job — the 100-consecutive-run or 14-day criteria in Promotion Criteria — not local runs. Flakes recorded by the job must be triaged before the affected gate can be promoted, and an unexplained flake on an `active` gate is the demotion signal.
4. Checker follow-up: once the CI artifact exists, extend the checker so `active` gates require at least one CI-provenance evidence run, and so evidence-run commit SHAs are verified to be ancestors of the branch under check.
5. Rebase audit: before any merge claim, mechanically verify every declared `testFiles` entry exists on fresh `origin/main` (or on the rebased tree) rather than trusting memory. The #6949 WebGL rename is the standing example of why.

## Milestone 2

After Milestone 1 works, add the next three gates as experimental entries with deterministic harnesses:

- `terminal-geometry.visible-convergence`
- `xterm-addon.boundary-containment`
- `startup-upgrade.persisted-session-corpus`

These should not become blocking until the team has red/green, runtime, and flake evidence. The goal is fewer useful gates, not a larger noisy suite.

## Milestone 3

Milestone 3 is where the plan stops being only a lower-layer regression net and starts exercising the real terminal runtime:

- Register existing terminal perf and E2E tests as experimental manifest gates only after reviewing their oracles, waits, artifacts, and flake history.
- Add the live local PTY gate with a tight oracle: spawn a shell, print a unique token, switch hidden-visible, assert the same PTY/session id, verify visible buffer content, type again, and prove no duplicate tab or blank pane appeared.
- Add Windows ConPTY coverage on Windows CI for echo, resize/readback, cursor visibility, CJK/emoji output, keyboard reset, shell resolution parity, and activation after restore.
- Add daemon degraded/startup reconcile contracts before relying on daemon fallback behavior.
- Add live SSH, WSL, remote-runtime mirror polling, and provider-listing edge contracts before treating remote/SSH restore as broadly covered; the current mocked SSH deferred-reattach and expired-relay tests are useful lower-layer proof, not live remote coverage.
- Add perf gates with explicit budgets for input latency, event-loop delay, hidden-output pressure, daemon stream backpressure, no hot `listSessions`, pending bytes, renderer ACK behavior, store hot paths, and runtime/mobile stream byte caps.
- Add IME/synthetic-input coverage at the lowest deterministic layer, with platform-specific manual or soak coverage only where real IMEs are required.

Milestone 3 gates should begin as `experimental`. They become `soak` only when the command is stable enough to run repeatedly and the failure artifact tells an engineer exactly what broke. They become `blocking` only after the promotion criteria above are satisfied.
