# Reliability Pain Points and Improvement Plan

Date: 2026-06-30

## Scope

This note summarizes the recent reliability review across:

- Recently merged reliability PRs, especially terminal/tab/startup/session work from 2026-06-26 through 2026-06-30.
- GitHub issues labeled `P0` and `P1`.
- Local git history for authorship when issue text or PR bodies named a regressing change.

The goal is to identify where Orca is hurting, what engineering improvements would reduce repeat incidents, and what can fairly be said about attribution.

## Issue Snapshot

At the time of review:

- Open `P0`: 9
- Total `P0`: 14
- Open `P1`: 191
- Open `P1` split: 90 bugs, 86 enhancements, 15 other

Last seven days reviewed: 2026-06-23 through 2026-06-30.

- Merged PRs in the window: 386
- `P0` issues created in the window: 8
- `P1` issues created in the window: 83

The last-seven-day issue set is the strongest signal for the current pain. It includes the new-tab autoclose `P0`, Windows terminal activation hangs, renderer CPU/input lag, Windows startup visibility failure, Codex config corruption on Windows, a large terminal/IME/rendering cluster, WSL/remote/provider drift, and agent/sidebar/session identity drift.

Open `P0` issues:

- [#6877](https://github.com/stablyai/orca/issues/6877): macOS 1.4.106 nested `simcam` dylib is unnotarized and rejected by Gatekeeper.
- [#6874](https://github.com/stablyai/orca/issues/6874): Windows `AppHangB1` when opening or activating a terminal session; runtime stuck in `stale_bootstrap`.
- [#6873](https://github.com/stablyai/orca/issues/6873): likely duplicate or near-duplicate of #6874, though the issue metadata says macOS while the title/body describe Windows.
- [#6795](https://github.com/stablyai/orca/issues/6795): app became very slow after an update; typing can lag by 2-5 seconds.
- [#6773](https://github.com/stablyai/orca/issues/6773): cannot create a new terminal tab or agent; the tab opens and closes immediately.
- [#6655](https://github.com/stablyai/orca/issues/6655): high `Orca Helper (Renderer)` CPU on Mac Mini M4 causing severe UI/input lag.
- [#5787](https://github.com/stablyai/orca/issues/5787): whole Windows window freezes; input dies in every pane; sessions close on click.
- [#5356](https://github.com/stablyai/orca/issues/5356): session loss on first launch after upgrading from 1.4.65 to 1.4.68.
- [#5314](https://github.com/stablyai/orca/issues/5314): Windows close button and Alt+F4 do nothing.

Closed `P0` issues worth keeping in the reliability history:

- [#6233](https://github.com/stablyai/orca/issues/6233): Windows window fails to appear while the process runs in the background.
- [#6163](https://github.com/stablyai/orca/issues/6163): Orca-managed Codex `config.toml` duplicate key.
- [#5377](https://github.com/stablyai/orca/issues/5377): native watcher main-process crash on macOS.
- [#5144](https://github.com/stablyai/orca/issues/5144): Windows close-confirmation deadlock.
- [#5109](https://github.com/stablyai/orca/issues/5109): sidebar agent status mismatch.

## P1 Reliability Clusters

The `P1` set is too large to treat as a flat list. The high-signal reliability clusters are:

### Terminal Rendering and Input

- [#6901](https://github.com/stablyai/orca/issues/6901): garbled text.
- [#6764](https://github.com/stablyai/orca/issues/6764): Windows terminal issues.
- [#6632](https://github.com/stablyai/orca/issues/6632): display artifacts in Claude Code full-screen TUI.
- [#6144](https://github.com/stablyai/orca/issues/6144): laggy Claude Code terminal scroll.
- [#5969](https://github.com/stablyai/orca/issues/5969): remote-over-SSH Codex display artifacts.
- [#5345](https://github.com/stablyai/orca/issues/5345): Windows/WSL scrolling causes duplicated or garbled text and content overlap.

### IME and International Text

- [#6905](https://github.com/stablyai/orca/issues/6905): Vietnamese IME input broken in terminal.
- [#6765](https://github.com/stablyai/orca/issues/6765): Linux Sogou Pinyin/fcitx only commits the first CJK character.
- [#6698](https://github.com/stablyai/orca/issues/6698): Vietnamese Telex input loses characters.
- [#5921](https://github.com/stablyai/orca/issues/5921): CJK characters duplicated in Orca terminal on Windows.
- [#5262](https://github.com/stablyai/orca/issues/5262): Arabic text rendering appears reversed or disconnected in terminal input.

### Paste and Clipboard

- [#5365](https://github.com/stablyai/orca/issues/5365): terminal freezes for seconds when pasting long text on Windows.
- [#5358](https://github.com/stablyai/orca/issues/5358): Windows paste preview collapses long text and cannot expand it.
- [#5919](https://github.com/stablyai/orca/issues/5919): generic paste reliability issue.
- [#5960](https://github.com/stablyai/orca/issues/5960): bad screen result when pasting links.
- [#6364](https://github.com/stablyai/orca/issues/6364): pasting images into an agent CLI does not work using Remote Host.

### SSH, Remote Runtime, WSL, and Provider Boundaries

- [#6106](https://github.com/stablyai/orca/issues/6106): SSH terminal loses pre-TUI shell output after Codex tab restore.
- [#6846](https://github.com/stablyai/orca/issues/6846): remote PTY sessions do not stay alive on disconnect.
- [#6908](https://github.com/stablyai/orca/issues/6908): WSL project added through UI does not discover branches/base refs, while CLI repo add works.
- [#6907](https://github.com/stablyai/orca/issues/6907): Codex launched in a WSL worktree does not appear in agent status/sidebar.
- [#6916](https://github.com/stablyai/orca/issues/6916): OMP launched in a WSL worktree has no live agent status.
- [#6032](https://github.com/stablyai/orca/issues/6032): Remote Orca Servers can lose host-scoped repo and project state.
- [#6688](https://github.com/stablyai/orca/issues/6688): viewing a diff on remote host errors.
- [#6753](https://github.com/stablyai/orca/issues/6753): remote-host GitHub merge errors.

### Agent, Tab, Session, and Sidebar State Drift

- [#6910](https://github.com/stablyai/orca/issues/6910): active agent tabs duplicate UI sessions when switching repositories.
- [#6803](https://github.com/stablyai/orca/issues/6803): multiple working agents thrash their order in the sidebar.
- [#6072](https://github.com/stablyai/orca/issues/6072): mobile keeps showing old agent rows after terminals are closed.
- [#5913](https://github.com/stablyai/orca/issues/5913): Pi compact agent row remains after closing its terminal tab.
- [#5718](https://github.com/stablyai/orca/issues/5718): OMP sessions not showing up in Agent Session History or filter options.
- [#5404](https://github.com/stablyai/orca/issues/5404): false "agent running" notifications persist after starting Claude Agents on VSSH/WSL.

### Mobile Terminal and Tabs

- [#5421](https://github.com/stablyai/orca/issues/5421): iOS workspace tabs do not open.
- [#6756](https://github.com/stablyai/orca/issues/6756): iOS terminal renders in cursive/italic font and continuously flickers.
- [#5628](https://github.com/stablyai/orca/issues/5628): mobile resizing feature request, closely related to terminal fit/reflow reliability.

### Browser, Profile, and Embedded Runtime

- [#6923](https://github.com/stablyai/orca/issues/6923): browser profiles do not isolate storage.
- [#6760](https://github.com/stablyai/orca/issues/6760): floating browser cannot load any page.
- [#6268](https://github.com/stablyai/orca/issues/6268): embedded-browser cookie/session limitation prevents Auth0 login.
- [#6875](https://github.com/stablyai/orca/issues/6875): cannot copy Google Chrome cookies database.
- [#6652](https://github.com/stablyai/orca/issues/6652): browser zoom broken.

### Startup, Install, and Platform Hangs

- [#5657](https://github.com/stablyai/orca/issues/5657): macOS startup PATH probe can hang under Endpoint Security agents.
- [#5107](https://github.com/stablyai/orca/issues/5107): Orca opens very slowly on Windows 11 and leaves a residual process.
- [#5989](https://github.com/stablyai/orca/issues/5989): Windows Defender blocks application during installation.

## Recent Reliability PR Context

The late-June reliability work clustered around the same few subsystems:

- New terminal tabs opening and immediately closing: [#6796](https://github.com/stablyai/orca/pull/6796), [#6801](https://github.com/stablyai/orca/pull/6801).
- Stale/frozen/blank terminals: [#6514](https://github.com/stablyai/orca/pull/6514), [#6800](https://github.com/stablyai/orca/pull/6800), [#6833](https://github.com/stablyai/orca/pull/6833), [#6830](https://github.com/stablyai/orca/pull/6830), [#6866](https://github.com/stablyai/orca/pull/6866).
- PTY size and layout desync: [#6644](https://github.com/stablyai/orca/pull/6644), [#6649](https://github.com/stablyai/orca/pull/6649), [#6684](https://github.com/stablyai/orca/pull/6684), [#6725](https://github.com/stablyai/orca/pull/6725), [#6785](https://github.com/stablyai/orca/pull/6785), [#6853](https://github.com/stablyai/orca/pull/6853).
- Renderer/xterm crash hardening: [#6852](https://github.com/stablyai/orca/pull/6852), [#6872](https://github.com/stablyai/orca/pull/6872), [#6855](https://github.com/stablyai/orca/pull/6855), [#6868](https://github.com/stablyai/orca/pull/6868), [#6856](https://github.com/stablyai/orca/pull/6856), [#6857](https://github.com/stablyai/orca/pull/6857).
- Windows shell/spawn/input: [#6537](https://github.com/stablyai/orca/pull/6537), [#6876](https://github.com/stablyai/orca/pull/6876), [#6858](https://github.com/stablyai/orca/pull/6858), [#6890](https://github.com/stablyai/orca/pull/6890).
- Hidden/agent startup behavior: [#6824](https://github.com/stablyai/orca/pull/6824), [#6798](https://github.com/stablyai/orca/pull/6798), [#6836](https://github.com/stablyai/orca/pull/6836).

## Last-Seven-Day Regression Origin Map

This section maps recent regressions to the place where the system failed, and to the gate that should catch the same class next time.

| Issue | Symptom | Regression point | Fix / related PR | Missing gate |
| --- | --- | --- | --- | --- |
| [#6773](https://github.com/stablyai/orca/issues/6773) | New terminal/agent tab opens and closes immediately | Dead-session reconciliation could treat a fresh PTY binding as absent from a stale `listSessions()` snapshot. This likely traces to the local dead-session reconcile path introduced for hidden exited panes in [#6514](https://github.com/stablyai/orca/pull/6514). | [#6796](https://github.com/stablyai/orca/pull/6796), [#6801](https://github.com/stablyai/orca/pull/6801) | Newborn terminal lifecycle test: create shell and agent tabs while liveness reconciliation is in flight; assert the tab cannot be closed by an older snapshot. |
| [#5356](https://github.com/stablyai/orca/issues/5356) | First launch after upgrade loses active floating/agent terminal sessions | Cold-restore relied on state that only versions after the fix could write, so users upgrading from pre-fix versions had no migration source. Issue text explicitly names [#5234](https://github.com/stablyai/orca/pull/5234) and [#5240](https://github.com/stablyai/orca/pull/5240). | Not fully closed in current open `P0` set | Upgrade fixture test: boot current app with persisted state from the last affected production version and assert active terminal/agent sessions are preserved or visibly recoverable. |
| [#5319](https://github.com/stablyai/orca/issues/5319) | Linux/Wayland terminals render but stop accepting keyboard/scroll input | Wayland-aware GPU safeguard was removed in [#1344](https://github.com/stablyai/orca/pull/1344), leaving eager GPU channel setup able to wedge terminal input on affected systems. | [#6557](https://github.com/stablyai/orca/pull/6557) | Platform GPU matrix test: Linux Wayland launch with terminal WebGL/input smoke and assertion that GPU flags preserve input, not only rendering. |
| [#6233](https://github.com/stablyai/orca/issues/6233) | Windows process runs but no window appears | Startup window reveal depended on Electron `ready-to-show`; if that event stalled, there was no fallback reveal or user-visible failure. | [#6462](https://github.com/stablyai/orca/pull/6462) | Startup watchdog test: simulate missing `ready-to-show` on Windows and assert the app either reveals or exits with a clear recovery path. |
| [#6163](https://github.com/stablyai/orca/issues/6163) | Orca-managed Codex `config.toml` fails with duplicate `hooks.state` keys on Windows | Two TOML writers serialized the same Windows path key differently, and Orca deduped textually rather than by decoded key. | [#6318](https://github.com/stablyai/orca/pull/6318), follow-up [#6388](https://github.com/stablyai/orca/pull/6388) bug-scan fix | Cross-writer config round-trip test: seed config with Codex-written literal Windows paths, run Orca hook sync twice, then parse with a TOML parser and assert one decoded key. |
| [#6244](https://github.com/stablyai/orca/issues/6244) | Headless-launched automation terminal showed only a bash prompt until unmount/remount | Hidden/background automation worktrees were not mounted early enough for output/replay to hydrate on first view. | [#6568](https://github.com/stablyai/orca/pull/6568) | Headless automation mount test: launch background automation, wait for output, first-focus the tab, and assert output is already visible. |
| [#6331](https://github.com/stablyai/orca/issues/6331) | WSL workspaces with UNC cwd hit `DaemonProtocolError` | Windows/WSL path handling crossed provider boundaries and daemon spawn assumptions. | [#6536](https://github.com/stablyai/orca/pull/6536) | WSL UNC provider contract: add/open/delete workspace whose root is `\\wsl.localhost\...`; assert daemon and file operations use the right host/path semantics. |
| [#6336](https://github.com/stablyai/orca/issues/6336) | Monorepo subfolder import opened the repo root instead of the selected subfolder | Git-root normalization leaked into the first-terminal cwd/user-facing workspace root behavior. | [#6574](https://github.com/stablyai/orca/pull/6574) | Add-project matrix: repo root, monorepo subfolder, folder workspace, remote runtime; assert file tree root and first terminal cwd separately. |
| [#6147](https://github.com/stablyai/orca/issues/6147) | Chinese full-width punctuation became half-width ASCII in terminal | IME/composition forwarding lacked coverage for macOS full-width punctuation and composition-owned text. | [#6417](https://github.com/stablyai/orca/pull/6417) | IME matrix test: macOS CJK full-width punctuation, Vietnamese Telex, Linux fcitx/Sogou, Windows CJK; assert committed bytes and displayed cells. |
| [#5656](https://github.com/stablyai/orca/issues/5656) / [#5653](https://github.com/stablyai/orca/issues/5653) | Windows Claude Code prompt showed phantom/overwritten characters until resize | Rewrite-style terminal output did not reliably force visible row repaint for CR/CHA/erase updates. | [#6544](https://github.com/stablyai/orca/pull/6544), [#6449](https://github.com/stablyai/orca/pull/6449) | Terminal redraw fixture: feed CR, CHA, backspace, erase-line/screen and assert visible cells after each chunk without resize. |
| [#5161](https://github.com/stablyai/orca/issues/5161) | PowerShell terminal failed to spawn with Windows error code 5 | Windows shell resolver handed ConPTY a bare `pwsh.exe`, which could resolve to an App Execution Alias stub. | [#6537](https://github.com/stablyai/orca/pull/6537), [#6876](https://github.com/stablyai/orca/pull/6876) | Windows shell resolution contract: auto and explicit PowerShell selections must resolve to real executables and skip WindowsApps aliases. |
| [#6270](https://github.com/stablyai/orca/issues/6270) | Restoring agent sessions was not working for SSH/runtime use cases | Resume logic and runtime host restrictions did not cover SSH workspaces. | [#6685](https://github.com/stablyai/orca/pull/6685) | Agent resume provider matrix: local, daemon, SSH, remote runtime, Windows shell; assert resume command is queued on the configured host/provider. |
| [#6852](https://github.com/stablyai/orca/pull/6852) / [#6872](https://github.com/stablyai/orca/pull/6872) | Terminal search could crash terminal surface on narrow viewports | xterm search decorations received invalid dimensions and threw through the terminal surface. | [#6852](https://github.com/stablyai/orca/pull/6852), [#6872](https://github.com/stablyai/orca/pull/6872) | xterm addon safety test: narrow viewport, zero/near-zero columns, wrapped matches, keyboard next/previous; assert addon errors are caught and pane remains usable. |
| [#6855](https://github.com/stablyai/orca/pull/6855) | xterm web-link provider `RangeError` could kill the Windows renderer | Link provider ran synchronously inside xterm with no guard around pathological wrapped lines. | [#6855](https://github.com/stablyai/orca/pull/6855) | Addon boundary policy: all xterm addon callbacks are guarded and failure disables only that addon for that pane. |
| [#6853](https://github.com/stablyai/orca/pull/6853) | Split-right PTY stayed at `0x0` and rendered a white screen | Deferred spawn measured an unlaid-out pane; post-spawn reconcile could terminate before forwarding a usable size. | [#6853](https://github.com/stablyai/orca/pull/6853) | Split spawn invariant: visible panes must never keep PTY size `0x0`; fallback size must be forwarded if measurement is unavailable. |

The repeated pattern is not one person repeatedly making the same mistake. It is that Orca does not yet have enough executable contracts around lifecycle, provider boundaries, terminal sizing, xterm safety, platform shell behavior, and upgrade state.

## PR Process Evidence

Reading the PR descriptions for the confirmed or likely regression chains shows that the failure was usually not "no process." The failure was that the process accepted plausible local validation without requiring the invariant that would have protected the escaped user path.

### #6514: Dead-Session Reconcile Introduced a Newborn-Tab Hazard

[PR #6514](https://github.com/stablyai/orca/pull/6514) was a Brennan-authored reliability fix for frozen terminal panes after a backgrounded agent exits. The PR body shows a substantial process: design review, completeness verification, headline behavior status, perf audit, code-review loop, Electron validation, and targeted unit tests. The stated non-goal explicitly excluded SSH/remote reconciliation, and the implementation revalidated pane/PTY identity at apply time.

What still got through:

- The PR protected "stale dead pane should close" but did not name the dual invariant "a fresh or newly bound pane cannot be closed by a liveness snapshot requested before that binding existed."
- The tests covered live/dead/remote/idempotency paths, but not the TOCTOU case where `listSessions()` is requested, a new PTY binds before the response returns, and the stale response omits the newborn id.
- Reviewers accepted "healthy panes are untouched" as a semantic claim, but the executable gate did not prove that claim under delayed session enumeration.

Skill implication:

- `brennan-yolo-lite`, `auto-design-review-fix`, `review-code`, and `brennan-test-changes` all need to force lifecycle changes to state the inverse safety property, not only the intended cleanup behavior.
- For terminal lifecycle changes, the review checklist should ask "what newer state can this async observation accidentally destroy?"

### #5234 and #5240: Session-Restore Fixes Missed Old-Version Upgrade Fixtures

[PR #5234](https://github.com/stablyai/orca/pull/5234) and [PR #5240](https://github.com/stablyai/orca/pull/5240) were Jinwoo-authored fixes for slow-startup daemon PTY restoration and quit-time agent session persistence. Their PR descriptions show AI review, negative controls, targeted tests, and high-quality e2e coverage against the newly modeled behavior.

What still got through:

- The tests proved the new behavior once the new data and startup gates existed.
- They did not appear to boot the current app against serialized persisted state from the affected production versions before the fix.
- The escaped class is an upgrade/migration class: a fix can be correct for state written after the fix while still losing users who upgrade from state written before it.

Skill implication:

- Startup, restore, daemon, and persistence PRs need an "old state corpus" gate: seed data from the last affected production version, not only state produced by current code.
- Negative controls should include "old production fixture fails before fix and is preserved after fix" when the bug is upgrade-related.

### #1344: GPU Rendering Parity Missed Linux Wayland Input Failure

[PR #1344](https://github.com/stablyai/orca/pull/1344) replaced global GPU opt-ins with VS Code-style GPU startup flags and terminal GPU acceleration settings. The PR description cites reference behavior and local tests, but it does not show the later, stricter Brennan PR process markers used in the June reliability fixes.

What still got through:

- The change removed or bypassed the Wayland-aware GPU safeguard later identified by [PR #6557](https://github.com/stablyai/orca/pull/6557).
- Validation covered configuration and pane lifecycle tests, but not a Linux Wayland terminal input smoke where rendering appears live while keyboard/scroll input is wedged.
- One TypeScript command was reported as failing on existing project-include issues, which made the PR less clean as a release-risk artifact.

Skill implication:

- Cross-platform rendering/startup changes need an explicit platform matrix tied to the failure mode: not just "renders," but "renders and accepts input."
- Reference implementations are useful context, but factory review must still require Orca-specific platform hazards to be named and tested or accepted.

### Regression Lessons From Fresh Review

Fresh reviewer passes on the recent regression chains pointed to these reusable misses. These are class-level gates, not new blame findings.

- [#6514](https://github.com/stablyai/orca/pull/6514) -> [#6773](https://github.com/stablyai/orca/issues/6773), fixed by [#6796](https://github.com/stablyai/orca/pull/6796) and [#6801](https://github.com/stablyai/orca/pull/6801): the original PR correctly proved the forward cleanup case, where a hidden local/daemon PTY exits and should reconcile on resume while live listed panes survive. The missed invariant was the inverse lifecycle property: a destructive liveness snapshot can only close state that existed before the snapshot was requested. The escaped path was a macOS local new shell or agent tab where `listSessions()` was requested, a new PTY bound before the response returned, the stale response omitted the newborn id, and the renderer routed the healthy binding through exit teardown. The next gate is a Terminal Snapshot Freshness and Ownership Gate: a fake daemon holds `listSessions()` at `t0`, binds a newborn PTY at `t1`, resolves the stale `t0` snapshot without that PTY, and asserts the tab/pane survives, still owns the same PTY, accepts input, and renders output. A later post-bind snapshot may close a genuinely dead PTY, but only when provider, pane, PTY id, and binding epoch still match.
- [#6800](https://github.com/stablyai/orca/pull/6800), with [#5240](https://github.com/stablyai/orca/pull/5240), [#6411](https://github.com/stablyai/orca/pull/6411), [#6514](https://github.com/stablyai/orca/pull/6514), and [#6833](https://github.com/stablyai/orca/pull/6833) as related context: the original fix correctly proved that active worktree-sleep records should not be claimed merely because old tab/layout state exists; visible connecting panes with restorable identity can own wake, stale hidden panes fresh-resume, and completed hibernation evidence stays passive. The missed invariant was provider-session ownership, not "pane connects now." For each provider-session claim key, exactly one durable owner must exist: a live hook/status for that same provider session, a queued/sent resume command for that same provider session, or an explicit retained record because spawn/connect failed. Layout match, PTY wake hints, replayed terminal bytes, and cold-restored screen snapshots are display evidence, not ownership evidence. The next gate is an Agent Provider Session Ownership Matrix covering active focused tabs, inactive tabs, visible non-focused splits, live/quit/worktree-sleep origins, replay-only/cold-restore-only/wrong-session/no-hook/delayed-hook cases, and repeated workspace activation.
- [#5234](https://github.com/stablyai/orca/pull/5234) / [#5240](https://github.com/stablyai/orca/pull/5240) -> [#5356](https://github.com/stablyai/orca/issues/5356): the original PRs correctly proved slow-daemon restoration and newly written quit-origin provider-session persistence. The missed invariant was first-open-after-upgrade compatibility: startup/restore fixes must preserve or explicitly recover user sessions from the last affected production persisted-state schema, not only from state written by the fixed build. The escaped path was first launch after a 1.4.65 -> 1.4.68 upgrade, including Windows 10 active floating shell and Claude panes, where the old version had no `sleepingAgentSessionsByPaneKey` payload to consume. The next gate is a Persisted Session Upgrade/Restore Contract: boot current Orca against immutable user-data fixtures from the last affected version, including active and inactive tabs, visible and hidden splits, old tab-level PTY wake hints, missing `sleepingAgentSessionsByPaneKey`, live/quit/worktree-sleep/legacy origins, repeat activation, and a second restart after current code writes upgraded state. The oracle rejects blank replacement panes, duplicate resume tabs, silent session loss, and "works only after current code writes new state."
- [#1344](https://github.com/stablyai/orca/pull/1344) -> [#5319](https://github.com/stablyai/orca/issues/5319) / [#6557](https://github.com/stablyai/orca/pull/6557): the original PR correctly attempted to replace broad GPU opt-ins with VS Code-style GPU channel flags and prove terminal GPU/WebGL fallback at unit level. The missed invariant was terminal platform liveness, not visual readiness. A terminal is healthy only if it renders output, receives focus, delivers keyboard input to the correct PTY, echoes process output back to the xterm buffer, scrolls, and survives GPU/renderer startup on the target platform. The next gate is a Terminal Platform Liveness Gate across Linux Wayland GPU paths, headless Weston plus at least one scheduled/manual headful Wayland run, control Linux/macOS/Windows paths when renderer policy is shared, active and inactive tabs, visible and hidden panes, first mount, tab switch, repeated workspace activation, local PTY, and SSH/remote PTY. Screenshots alone never pass.
- [#6644](https://github.com/stablyai/orca/pull/6644) / [#6649](https://github.com/stablyai/orca/pull/6649) / [#6725](https://github.com/stablyai/orca/pull/6725) / [#6785](https://github.com/stablyai/orca/pull/6785) / [#6794](https://github.com/stablyai/orca/pull/6794) / [#6853](https://github.com/stablyai/orca/pull/6853) / [#6939](https://github.com/stablyai/orca/pull/6939): the fixes correctly proved pieces of the PTY geometry class: first-mount column desync, single-frame insufficiency, split-mount convergence, requested-size versus applied-size drift, mobile-owned PTY exceptions, visible split `0x0` fallback, and visible geometry reassertion after stable fit. The missed invariant was cross-layer terminal geometry authority. A visible desktop-owned terminal is not valid until xterm `cols/rows`, fit/proposed dimensions, applied PTY winsize, shell-visible `stty`/`stdout.columns`, and echo-wrap behavior converge after layout settles. Hidden/inactive panes may defer resize, and mobile/remote providers may intentionally diverge, but every transition into visible desktop ownership must converge. The next gate is a terminal geometry matrix with fault injection for first `0x0` fit, delayed layout settle, dropped/delayed resize acknowledgement, requested-size-versus-applied-size drift, SSH-style unknown applied size, hidden-to-visible activation, split create/collapse, restore, repeated workspace activation, and no redundant hidden SIGWINCH.
- [#6852](https://github.com/stablyai/orca/pull/6852) / [#6872](https://github.com/stablyai/orca/pull/6872) / [#6855](https://github.com/stablyai/orca/pull/6855), with [#6868](https://github.com/stablyai/orca/pull/6868), [#6856](https://github.com/stablyai/orca/pull/6856), and [#6857](https://github.com/stablyai/orca/pull/6857) as nearby WebGL/renderer-risk hardening: the fixes correctly moved toward safe wrappers for search dimensions, keyboard search navigation, link providers, WebGL addon patches, and renderer/GPU crash fallback. The missed invariant was xterm addon boundary containment. Optional addons are untrusted boundary code: search decorations, link providers, WebGL attach/reset/dispose, renderer fallback, hover callbacks, and stale async callbacks must not throw across the pane, React, or window boundary. The next gate is an xterm-addon-boundary harness that injects throwing addon behavior under active tabs, inactive tabs, visible and hidden splits, hidden-to-visible resume, floating tab switch, repeated workspace activation, and pane destroy/recreate; the oracle is pane-scoped addon disable/degrade with one breadcrumb, no React/window crash, and surviving focus, input, PTY echo, and rendering.

Concrete gate shapes from the fresh passes:

- **Snapshot freshness harness**: defer and reorder `listSessions()` / `listTerminals()` responses. Request a snapshot at `t0`, bind a new PTY at `t1`, resolve the `t0` response without the new PTY, and assert the pane survives with PTY id, tab ownership, and input/output proof. Then request a fresh `t2 > t1` snapshot for a genuinely killed PTY and assert teardown works. Run active/inactive tabs, visible/hidden splits, first-input probes, restore/reattach, repeat activation, and SSH/remote unknown-liveness variants.
- **Provider-session ownership matrix**: model provider-session ownership separately from terminal render output. For live, quit, active worktree-sleep, and completed worktree-sleep origins, prove each provider session is exactly one of owned, resuming, or intentionally retained. Cover active focused tabs, inactive hidden tabs, visible non-focused splits, delayed/missing/wrong hooks, duplicate legacy records, fresh-spawn failure, and repeat activation. Displayed replay must never count as ownership.
- **Old-version restore corpus**: keep immutable user-data fixtures from the last affected production versions, especially pre-#5232 session state. Boot current Orca against those fixtures and assert every persisted PTY/agent record is preserved, resumed once, warm-reattached once, or visibly marked unrecoverable. Include second restart after current Orca writes upgraded state.
- **Wayland platform liveness**: extend the Linux Wayland verifier so it proves terminal render, focus, keyboard input, PTY echo, scrollback movement, and GPU crash/stall absence across active/inactive tabs, visible/hidden splits, first mount, tab switch, restore, repeated activation, local PTY, and SSH/remote runtime. Screenshot-only evidence is not enough.
- **Terminal geometry convergence**: add an `assertTerminalGeometryConverged` oracle that compares xterm cols/rows, fit/proposed dimensions, applied PTY size when available, shell-visible `stty size` / `$COLUMNS`, and deterministic echo/wrap behavior. Inject dropped resize, delayed resize until visible, stale applied size, null SSH-style readback, initial `0x0`, and layout settling after more frames than old fixed budgets.
- **xterm addon boundary harness**: inject throwing search decorations, link providers, WebGL attach/reset/dispose, and stale async callbacks under active tab, inactive tab, visible split, hidden split, hidden-to-visible resume, floating tab switch, repeat activation, and pane destroy/recreate. Assert no `window.onerror` or React boundary hit, one structured breadcrumb, addon-scoped degradation, focus/input survival, PTY/output rendering, and WebGL fallback to DOM when needed.

### Corrective PRs Show the Desired Direction

The later fixes, especially [#6801](https://github.com/stablyai/orca/pull/6801), show the right shape: root-cause description, happens-before proof, explicit `auto-design-review-fix`, completeness verification, code-review loop, `brennan-test-changes`, and targeted tests for the stale snapshot/newborn binding race. [#6852](https://github.com/stablyai/orca/pull/6852), [#6853](https://github.com/stablyai/orca/pull/6853), and [#6855](https://github.com/stablyai/orca/pull/6855) also show good local invariant tests around xterm addon throws and PTY `0x0` sizing.

The process improvement is to make that shape mandatory before the regression escapes, and to promote only the deterministic, red/green parts into blocking CI.

## Core Pain Points

### 1. Terminal Lifecycle Is Inferred Instead of Owned

Many paths infer terminal state from a combination of pane visibility, provider session membership, stored pane layout, active leaf ids, sleeping-agent records, and xterm mount state. That makes it easy for a stale observation to tear down a fresh pane, or for a dead pane to look live.

Common symptoms:

- New tab opens and immediately closes.
- Hidden terminal exits but the visible pane later looks frozen and swallows input.
- Sleeping or hibernated agents get stranded in stale panes.
- Mobile and desktop disagree about which terminal/session still exists.

### 2. PTY Size Authority Is Split Across Too Many Places

`FitAddon`, `ResizeObserver`, deferred `requestAnimationFrame`, mobile-fit locks, hidden-pane guards, PTY locks, split layout equalization, and provider resize forwarding all compete to decide the active terminal size.

Common symptoms:

- PTY born at `0x0`.
- White split pane.
- First-mount column desync.
- TUI output wraps at the wrong width until manual resize.
- Mobile-size terminals fight desktop-size restoration.

### 3. xterm Addons Are Unsafe Boundary Code

The terminal surface trusts addon behavior too much. Recent failures came from search decorations, web-link providers, WebGL texture atlas resets, CJK/wide glyph rendering, and synchronized-output buffering.

Any addon that can throw synchronously or produce invalid dimensions can take down the workbench unless Orca wraps it defensively.

### 4. Provider Semantics Drift

Local PTY, daemon PTY, SSH relay, remote runtime, WSL, Windows ConPTY, Linux Wayland, and mobile sessions do not share the same truth source for liveness, size, replay, cwd, shell, or reconnect behavior.

Common symptoms:

- Local-only liveness checks are accidentally applied to SSH/remote panes.
- Remote paths miss fixes made only in the renderer.
- WSL works through CLI add but not UI add.
- Daemon can be protocol-healthy while PTY spawn is degraded.

### 5. Agent Identity Is Coupled to Terminal UI Details

Agent status, sidebar rows, compact rows, mobile session tabs, sleeping-agent records, terminal helper identity, and pane reuse all share responsibility for "what agent is this?"

Common symptoms:

- Duplicate agent tabs.
- Stale sidebar rows after terminal close.
- Wrong agent icon/title.
- False running/completed notifications.
- Worktree switching changes agent ordering or ownership.

Class-level invariant:

- Agent/provider session replay must be ownership-safe. When code touches agent launch, restore, sleep, hibernate, dedupe, clearing, or workspace activation, it must prove Orca does not replay or resume a provider session id that is already owned, queued, pending, or live in that workspace. This applies across active and inactive tabs, visible and hidden panes, repeat activation of the same workspace, and session records whose origin is live, quit, or worktree sleep.
- Motivating example: the #6800 escape showed how code can conflate "this pane will connect right now" with "this pane/session owns this provider session." A valid inactive or hidden existing session can then look unowned, causing workspace activation to replay `agent resume <same-session-id>` instead of recognizing the session is already represented. The gate should protect the whole class, not only the #6800 path.
- Display evidence is not ownership evidence. Replayed terminal bytes, cold-restored screen snapshots, tab layout matches, and "will connect soon" state must never count as proof that a provider session id is already claimed.

### 6. Upgrade and Startup Are Under-Tested as First-Class Flows

Several failures only appear after an app update, daemon survival across versions, old persisted state, stale helper paths, or a first launch after migration.

Common symptoms:

- First launch after upgrade loses sessions.
- Daemon remains reachable but cannot spawn PTYs.
- App process runs but no window appears.
- Release packaging/notarization works at top level but fails for a nested binary.

### 7. Reliability Fixes Can Regress Performance or Crash Safety

Several reliability fixes add watchers, reconciliation loops, terminal replay, git scans, or richer diagnostics. Those are high-risk performance surfaces if they wake hidden panes, serialize large state, multiply subprocesses, or make cleanup scans wait for final results before showing progress.

Common symptoms:

- Terminal input becomes correct but slower under foreground TUI redraw or background PTY output.
- Hidden panes keep waking the renderer for data/title/spinner frames.
- Store subscribers or persistence writes serialize large terminal/worktree maps on common interactions.
- Git/worktree cleanup opens a modal that spins, duplicates rows, hangs on a subprocess, or crashes on Windows/WSL/SSH paths.
- Safety checks run unbounded git subprocesses or trust stale cleanup evidence before destructive removal.

## Proposed Improvements

### A. Build a Terminal Lifecycle State Machine

Create a single source of truth for terminal lifecycle:

- `newborn`
- `connecting`
- `live`
- `hidden-live`
- `exited-observed`
- `exited-unobserved`
- `hibernated`
- `restoring`
- `degraded`
- `closed`

All teardown, restore, reconnect, hibernation, and liveness decisions should transition through this machine. Avoid having individual React effects independently infer lifecycle from partial state.

### B. Make Liveness Reconciliation Epoch-Based

Every pane/PTY binding should carry a monotonic renderer-local epoch or generation. Any async liveness snapshot must include the epoch it was requested against.

Rules:

- A snapshot requested before a bind cannot close that bind.
- A provider membership result can only prove death when the current binding still exactly matches the request context: pane id, provider id, connection id, PTY id, and epoch.
- Remote/SSH/WSL providers must supply provider-scoped liveness, or the reconciler must treat them as unknown.

This generalizes the timestamp guard added for newborn terminal tabs and makes it harder to reintroduce the class.

### C. Define a PTY Size Ownership Protocol

Document and enforce one protocol for size authority:

- Initial spawn size source.
- Hidden-pane spawn behavior.
- Mobile-fit lock behavior.
- Split layout settle behavior.
- Fallback size behavior.
- Provider resize acknowledgement.
- Applied PTY size reporting.
- Dropped, delayed, or skipped resize recovery.
- Hand-off from reconcile loop to live `ResizeObserver`.

Add invariant tests that a visible terminal never remains `0x0`, and that xterm `cols/rows` converge with PTY-reported `cols/rows` under split, restore, reload, and mobile-fit scenarios.

Class-level invariant:

- A visible terminal pane must have one authoritative size path from layout measurement to xterm fit to provider resize to applied PTY size. `0x0` and unknown layout measurements are non-authoritative for visible panes. If a resize is skipped because of a mobile lock, PTY lock, hidden state, split layout settle, first mount, provider delay, or dropped acknowledgement, Orca must keep reconciling until the applied PTY size and xterm size converge or the pane enters an explicit degraded state.

Required deterministic hooks:

- Force first measurement to `0x0` during split-right spawn.
- Delay split layout settlement across frames.
- Hold and release mobile-fit or PTY locks while reconcile is active.
- Drop or delay one provider resize acknowledgement.
- Report applied PTY size separately from requested size.
- Switch hidden-to-visible or worktree-to-worktree while a resize is pending.

Required oracle:

- After the fault, assert visible xterm `cols/rows`, provider-reported applied PTY `cols/rows`, and process-observed `stdout.columns/rows` converge.
- Assert a width-sensitive TUI or long-line fixture renders without one-column wrapping.
- Assert typed input reaches the process and echoed output appears after convergence.
- Assert no test is promoted to blocking if it relies on blind `waitForTimeout()` instead of size/lifecycle events or controlled fault release.

### D. Add Provider Contract Tests

Start with a deterministic fake/fault-injection provider, then run the same lifecycle contract against real providers.

The fake provider should be able to:

- Delay and reorder `listSessions()` responses.
- Return `unknown` separately from empty/live/dead.
- Delay attach/replay and resize acknowledgements.
- Kill processes while panes are hidden.
- Drop or duplicate exit/replay/resize events.
- Simulate stale cwd/helper paths.

After the fake provider is stable, run the contract against:

- local PTY
- daemon PTY
- degraded daemon wrapper
- SSH relay
- remote runtime
- WSL path/shell combinations
- mobile session replay

Required scenarios:

- spawn
- hidden spawn
- visible restore
- hidden exit
- reconnect
- resize before/after mount
- cwd deleted
- helper binary moved after upgrade
- process dies while renderer is hidden

### E. Create a Terminal Torture Harness

Add a nightly and pre-release reliability suite that exercises:

- rapid tab create/close
- agent create/close
- split right/down
- reload with split layout
- hidden-to-visible switching
- huge streaming TUI output
- CJK, Vietnamese, Arabic, and emoji input/output
- long paste, link paste, image paste
- browser/terminal focus handoffs
- hibernation wake
- daemon restart/degraded fallback
- mobile connect/disconnect during active terminal traffic

This should record screenshots, terminal snapshots, PTY sizes, lifecycle transitions, and renderer CPU.

Each scenario must also declare its oracle before it can be promoted beyond `experimental`: the observable pass condition, the failure artifact, and whether it is a discovery/stress run or a merge-blocking gate. Stress scenarios without deterministic oracles should stay nightly/pre-release only.

### F. Wrap xterm Addons Behind Safe Adapters

Search, links, WebGL, decorations, and input-protocol helpers should be treated as untrusted code:

- Catch synchronous addon throws.
- Validate all rows/cols/decoration dimensions before calling xterm APIs.
- Disable or degrade an addon for a pane after repeated failures.
- Emit a structured breadcrumb with pane id, provider, terminal size, addon name, and sanitized error.

Class-level invariant:

- xterm addon failures must be contained to the addon and pane. A search, link, WebGL, decoration, input-protocol, or keyboard-navigation error must never unmount the terminal surface, crash the renderer, break focus, or stop typed input/output for the PTY. Invalid dimensions, wrapped-line ranges, zero columns, texture atlas resets, and synchronous callback throws should either be validated away before the addon call or caught and downgraded after the call.

Required deterministic hooks:

- Force zero or near-zero terminal columns.
- Force wrapped search and link ranges across line boundaries.
- Throw from search, link, decoration, and WebGL callback boundaries.
- Simulate WebGL texture/atlas reset or addon initialization failure.
- Invoke next/previous search navigation while the search addon reports an invalid match.

Required oracle:

- The terminal pane remains mounted and focused.
- The failing addon is disabled or downgraded only for the affected pane.
- A structured breadcrumb names the addon and sanitized failure.
- Typed input reaches the process and echoed output appears after the addon failure.

### G. Add Upgrade Fixtures

Keep serialized workspaces and daemon/session state from known old versions:

- pre-#5232 session restore data
- stale daemon cwd
- stale node-pty helper path
- old hibernated agent records
- old mobile session snapshots
- old Windows shell settings

CI should boot the current app against these fixtures and assert no session loss, no blank first pane, and no startup deadlock.

Fixture rules:

- Name the exact production version and build source.
- Store the pre-migration state immutably and copy it to a temp profile before boot.
- Document the expected pre-migration shape and post-migration behavior.
- Include stale daemon/helper/path state when that is the real user upgrade path.
- Treat silent blank replacement as a failure. If exact restoration is impossible, the accepted outcome must be an explicit recoverable/degraded state or user-facing migration notice, not silent session loss.

### H. Add Platform Startup, Input, and Release Artifact Contracts

Some failures look visually healthy while the product is broken. Platform contracts must prove the user action, not only the frame.

Required contracts:

- Terminal rendering/input: on Linux Wayland, Windows ConPTY, and macOS, assert the terminal renders, accepts typed input, echoes process output, scrolls, and preserves focus after GPU/renderer startup paths touched by the PR.
- IME/input: when terminal input handling changes, assert representative CJK, Vietnamese, Arabic, paste, and modifier paths at the lowest deterministic layer available.
- Startup/window lifecycle: packaged app reveals, close button and Alt+F4 work on Windows, startup watchdogs recover when `ready-to-show` stalls, and PATH/shell probes time out with a recoverable state.
- Release artifact: packaged builds include required nested binaries and pass signing/notarization checks, not only top-level app validation.
- Daemon degradation: daemon reachable-but-unable-to-spawn and stale helper/cwd states produce a visible degraded path instead of blank or frozen terminals.

### I. Add an Agent Identity Contract

Provider and terminal tests are not enough for agent/session identity drift. Add a contract for:

- Pane reuse and tab close.
- Worktree switch and sidebar ordering.
- Sleep/wake and hibernation records.
- Provider session id capture and consumption.
- Mobile rows and desktop rows converging after terminal close.
- False running/completed notifications.
- Agent history/filter visibility for restored sessions.
- Provider session replay ownership: workspace activation, launch, restore, sleep/hibernate, dedupe, clearing, and reconnect code must not issue a second resume/launch for a provider session id already owned by an active tab, inactive tab, visible pane, hidden pane, queued pane, pending connection, or live session in the same workspace.
- Session record origins: the same invariant must be proved for live sessions, quit-restored sessions, and worktree-sleep records, including repeat activation of an already-active workspace.

Required agent identity scenarios:

- Activate a workspace with an existing visible live agent pane; assert no duplicate `resume <provider-session-id>` is queued.
- Activate a workspace with an existing hidden/inactive live agent pane; assert the provider session is recognized as represented even before the pane visibly reconnects.
- Re-activate the same workspace repeatedly while agent restore/session discovery is pending; assert the pending ownership claim dedupes all replay attempts.
- Restore a quit-origin session and a worktree-sleep-origin session; assert each is claimed once, survives hidden-to-visible transitions, and does not produce duplicate sidebar/mobile rows.
- Clear or close stale panes while a same-session replacement is queued or pending; assert cleanup cannot erase the newer ownership claim or trigger a second replay.

### J. Introduce Reliability Gates for Terminal/Session PRs

For PRs touching terminal, agent status, sessions, startup, provider routing, or hibernation, require:

- Provider matrix explicitly listed.
- Hidden-pane behavior listed.
- SSH/remote behavior listed.
- Windows/WSL behavior listed when shell, cwd, path, ConPTY, or process launch is touched.
- A regression test that fails against the old behavior.
- A manual or automated stress command if the change touches timing.
- PTY size authority proof when the PR touches terminal spawn, split layout, hidden/visible transitions, mobile fit, resize forwarding, PTY locks, provider resize acknowledgement, or xterm fit. The proof must cover `0x0` quarantine, requested versus applied PTY size, xterm/process size convergence, and a user-visible input/output oracle.
- Agent/provider replay ownership proof when the PR touches agent launch, restore, sleep/hibernate, dedupe, clearing, workspace activation, pane reuse, provider session id capture, sidebar/mobile agent rows, or session history. The proof must cover active versus inactive tabs, visible versus hidden panes, repeat workspace activation, and live, quit, and worktree-sleep session record origins.
- xterm addon containment proof when the PR touches search, links, WebGL, decorations, keyboard terminal shortcuts, synchronized output, or xterm addon registration. The proof must show addon throws and invalid geometry cannot crash the terminal surface, unmount the pane, or break typed input/output.
- The terminal/session checklist should explicitly ask: "Can this change make an already represented provider session look unowned, or replay/resume it a second time?"
- The terminal/session checklist should explicitly ask: "Can this change make a visible pane trust `0x0`, stale requested size, or renderer-only size instead of the size the PTY actually applied?"
- The terminal/session checklist should explicitly ask: "Can an xterm addon callback or invalid addon geometry throw through the terminal surface instead of being contained?"

### K. Make Reliability Tests Predictable and Useful

The goal is not "more tests." The goal is a small set of executable contracts that protect named invariants from real failures.

Required shape for every new reliability gate:

- Name the invariant it protects.
- Name the real issue, PR, or failure mode that motivated it.
- Prove red/green: the gate must fail against the old behavior, a regression fixture, or a small intentionally broken variant before it becomes a trusted blocker.
- Attach a promotion record: invariant id, motivating issue/PR, old-fail evidence, new-pass evidence, exact command, failure output or CI link, deterministic wait condition, owner, runtime budget, and demotion rule.
- Pick the cheapest deterministic layer: pure state-machine or provider-contract tests first, integration tests second, Electron/UI tests only for the small number of golden paths that require the real app shell.
- Avoid sleeps as proof. Wait for observable state, protocol events, lifecycle transitions, PTY size convergence, replay completion, or process exit.
- Record why the test is allowed to block merges: expected runtime, flake history, covered invariant, and owner.

Test maturity levels:

- `experimental`: local or nightly only; useful for shaking out the harness, not allowed to block merges.
- `soak`: runs repeatedly in CI but non-blocking; collects flake rate, runtime, and whether failures are actionable.
- `blocking`: promoted only after red/green proof, stable runtime, and low flake rate.

Flake policy:

- Blocking promotion should require numeric evidence, for example 100 consecutive soak runs or 14 days across required CI platforms, p95 runtime within the gate budget, and zero unexplained flakes. Tune the numbers later, but do not leave "stable" undefined.
- A blocking reliability test that flakes above the agreed threshold should be demoted or fixed quickly; rerun-only culture hides weak gates.
- CI should quarantine or demote a blocking test automatically when it exceeds the threshold over the configured window, open or update an owner issue, and require a fresh soak window before re-promotion.
- A flaky test should be treated as a product or harness bug with an owner, not as background noise.
- If a scenario cannot be made deterministic yet, keep it as soak/manual evidence and do not let it become required CI until the signal is trustworthy.

Deletion policy:

- Delete or demote tests that do not map to an invariant, duplicate a stronger gate, assert implementation details instead of behavior, only fail from timing/environment noise, or require blind sleeps.
- Prefer one high-signal contract test over several UI tests that all exercise the same happy path.
- Track regression coverage by invariant, not by raw test count.
- Maintain a reliability-gates manifest in the repo. Each gate should list invariant id, motivating issue/PR, layer, owner, maturity, runtime budget, flake history link, promotion record, and replacement gate if deprecated. Tests without current metadata should fail review or be demoted.

How to know the program is working:

- Every recent P0/P1 reliability class maps to an invariant and an executable gate or explicitly accepted gap.
- New gates carry red/green evidence.
- Blocking gate flake rate and runtime stay within budget.
- Future incidents identify either a missing invariant, a failed gate, or an explicit accepted gap instead of requiring archaeology.
- Accepted gaps have an owner, reason, affected platforms/providers, issue link, and expiry date. Expired gaps should block future high-risk PRs until renewed or closed.
- The dashboard tracks touched high-risk PRs, gates required, gates implemented, accepted gaps by age/owner, promotions, demotions, and escaped regressions by invariant.

### L. Make Performance and Git Crash Safety First-Class Gates

Correctness gates must include a performance budget when the fix touches terminal throughput, hidden panes, store subscribers, persistence, startup, polling, git/worktree scans, cleanup modals, subprocesses, SSH/WSL providers, or Windows git paths.

Required performance contract:

- Name the user-visible performance symptom that could regress: typing latency, scroll/resize jank, terminal throughput, startup delay, modal loading, CPU, memory, subprocess churn, or crash/reload.
- Name the resource being protected: renderer frame time, event-loop delay, PTY IPC count, xterm writes, serialized bytes, subprocess count, file descriptors, WebGL contexts, webviews, or retained buffers.
- Add a before/after measurement or deterministic count/leak test. Do not rely on "felt faster."
- Keep foreground input echo and control responses latency-sensitive while batching background or high-volume redraw streams.
- Prove hidden snapshot-capable panes do not wake the renderer per PTY chunk/title frame and restore from main-owned buffers when shown.
- Preserve `orca terminal read` pagination, cursor metadata, bounded preview behavior, partial-line handling, truncation flags, and total counts when changing terminal buffering.
- Prove subscriber, persistence, and publication paths avoid unchanged large slices and record serialized byte size when persisted payloads are touched.
- Keep stress/torture runs non-blocking until they have numeric runtime and flake evidence.

Required git crash/perf contract:

- Bound every git subprocess in scan/cleanup paths with a timeout or abort signal, and kill the process tree where applicable.
- Use bounded concurrency and in-flight dedupe; avoid one subprocess per repo x worktree x polling tick.
- Stream progress incrementally to the renderer and remove IPC listeners in `finally`.
- Verify close/reopen/refresh during active or just-settled scans clears loading state, preserves rows, and does not duplicate progress.
- Recheck cleanup candidates immediately before destructive delete, including dirty files, unpushed commits, unknown upstream/base, folder repos, main worktrees, pinned workspaces, running terminals, disconnected SSH, and WSL paths.
- Keep local, WSL, and SSH git providers at parity for timeouts, aborts, errors, and path handling.
- On Windows-risky cleanup changes, validate a real Electron flow when feasible: progress appears before final completion, close/reopen recovers, a clean old worktree delete does not crash, and no orphan Electron/git process remains.

Promotion rule:

- A reliability fix cannot become a blocking gate if it makes the product slower or crashier. The promotion record must include the perf command or measurement, budget, result, platform/provider scope, and any accepted perf gap.

### M. Make the Factory Enforce Those Gates

The factory should turn the reliability gate into default behavior for planning, review, and merge-confidence testing. This should be treated as part of the prevention plan, not as a substitute for the actual test harnesses and CI gates above.

Factory changes to carry forward:

- `brennan-yolo-lite` should require a Reliability regression gate in the design doc whenever terminal, tab, session, provider, startup, upgrade, persistence, packaging, shell, path, or release behavior is touched.
- The gate should force the agent to classify touched P0-capable surfaces: terminal lifecycle, tab creation/binding, dead-session reconciliation, hidden-to-visible resume, PTY identity/routing, PTY geometry including `0x0` quarantine, xterm addon boundaries, IME/paste/redraw behavior, local/daemon/SSH/remote/WSL/mobile provider contracts, attach/replay/resize/exit ordering, startup/upgrade persisted state, daemon survival, renderer/GPU crash containment, packaging/notarization, shell/PATH probing, terminal throughput, hidden-pane output, store subscriber hot paths, persistence payload size, git/worktree scan subprocess churn, cleanup modal progress, and Windows/WSL/SSH git crash risk.
- Completeness verification should block when a touched P0-capable surface has no implemented or explicitly accepted reliability gate.
- `review-code` should treat missing reliability tests or validation gates as findings for these surfaces, with the same review weight as lifecycle, provider, or cross-platform regressions.
- `review-code` should invoke the `perf` skill for slow UI, terminal throughput, high CPU, memory/resource leaks, polling, subprocess churn, startup latency, render churn, or persistence writes.
- `review-code` should invoke the `git-crash-perf` skill for worktree cleanup, git scans/status/listing, destructive removal, cleanup modal progress, SSH/WSL git providers, subprocess timeouts, or Windows git crash risk.
- `brennan-test-changes` should run or explicitly justify the relevant terminal torture, provider contract, startup/upgrade, persisted-state, release, cross-platform, perf, or git crash/perf matrix subset.

Current implementation status:

- Internal factory skill update PR: https://github.com/stablyai/orca-internal/pull/491
- Scope of that PR: add the reliability gate to `brennan-yolo-lite` and expand `review-code` to inspect the recent terminal/session/provider/startup/release failure classes.
- Follow-up needed: once the concrete repo-side harnesses exist, update the skills again to name the exact commands and required CI jobs instead of only naming the expected reliability evidence.

Additional factory follow-up:

- `auto-design-review-fix`: treat missing reliability gates for P0-capable surfaces as design findings; require inverse invariants for cleanup/reconcile/init code.
- `review-code-fix-loop`: require the final loop report to name the touched reliability classes, invariant, gate, and whether both reviewers addressed them. A clean review that never discusses the required reliability class should not count as clean.
- `brennan-test-changes`: add merge-confidence sub-gates for stale snapshot/newborn binding races, hidden-to-visible resume, attach/replay/exit ordering, old-version persisted state, provider/platform matrices, and render-live/input-live checks.
- `pr-review`: classify P0-capable surfaces before review/fix and require the same invariant/test/platform matrix before approval.
- `yolo-lite` and `electron`: require terminal/runtime validation to prove input, scroll, focus, process output, and relevant platform behavior, not only screenshots or visible frames.
- `playwright-reliability-tests`: add a focused skill for writing and reviewing Playwright tests that are evidence-based, low-flake, and tied to named invariants, so browser/Electron tests do not become more noisy checklist coverage.
- `perf`: require measurement-backed review for terminal throughput, hidden pane output, store subscribers, persistence, startup, polling, subprocess churn, resource leaks, and memory growth.
- `git-crash-perf`: require bounded subprocesses, progress streaming, close/reopen recovery, fresh delete preflight, provider parity, and Windows Electron validation for git cleanup/worktree changes.

### N. Add Pane Lifecycle Telemetry and Diagnostics

Each terminal pane should be able to emit a compact lifecycle trace:

- pane id, tab id, worktree id
- provider and connection id
- pty id and binding epoch
- visibility transitions
- spawn/connect timestamps
- resize measurements and forwarded sizes
- liveness snapshot request/response times
- teardown reason
- hibernation/restore reason

This will make future reports much easier to attribute without guessing. It should also be test-consumable: CI should be able to fail on forbidden transitions, stale close attempts, stuck `0x0`, missing input echo, and startup watchdog expiry.

## Attribution Methodology

"Who caused it?" is not reliably answerable from labels alone. This review separates:

- **Confirmed**: the issue body or fix PR explicitly names the introducing PR/change.
- **Likely**: the fix PR identifies the failing subsystem and local git history shows the regressing mechanism was introduced by a specific PR.
- **Area ownership**: the same people are repeatedly fixing or modifying the subsystem, but there is not enough evidence to say they caused a given issue.
- **Systemic**: no single introducer is evident; the problem is a missing invariant, provider contract, or test harness.

## Attribution Findings

### Confirmed Regression Chains

- [#5356](https://github.com/stablyai/orca/issues/5356), session loss on first launch after upgrading from 1.4.65 to 1.4.68, explicitly names PRs [#5234](https://github.com/stablyai/orca/pull/5234) and [#5240](https://github.com/stablyai/orca/pull/5240). Local git history shows both PRs were authored by Jinwoo Hong. Count: Jinwoo 1 confirmed open `P0` regression chain.
- [#5319](https://github.com/stablyai/orca/issues/5319), Linux/Wayland terminal input freeze, is closed, but the fixing PR [#6557](https://github.com/stablyai/orca/pull/6557) says the Wayland-aware GPU path had been removed in [#1344](https://github.com/stablyai/orca/pull/1344). Local git history shows #1344 was authored by Neil. Count: Neil 1 confirmed closed `P1` regression chain.

### Likely Regression Chains

- [#6773](https://github.com/stablyai/orca/issues/6773), new terminal/agent tabs opening and immediately closing, was fixed by [#6796](https://github.com/stablyai/orca/pull/6796) and [#6801](https://github.com/stablyai/orca/pull/6801). Those PRs identify the dead-session reconciler as the cause. Local git history shows [#6514](https://github.com/stablyai/orca/pull/6514), which introduced the focused dead-session reconcile module for hidden exited panes, was authored by Brennan Benson. Count: Brennan 1 likely open `P0` regression chain.

### Area Ownership Without Clear Causation

The recent terminal reliability churn is concentrated among Brennan, Neil, and Jinwoo because they authored many of the fixes and nearby changes. That does not mean each issue was caused by them. It does mean the riskiest ownership surfaces are:

- Terminal lifecycle/reconcile/session persistence: Brennan, Neil, Jinwoo.
- PTY size/layout/reflow: Neil, Jinjing, Jinwoo, Brennan.
- Daemon/degraded spawn/focus/remote lifecycle: Neil, Jinwoo.
- Windows terminal/shell/ConPTY/GPU recovery: Brennan, Neil, Jinwoo.
- Agent status/sidebar/session identity: Brennan, Neil, Jinwoo, Jinjing.

### Current Conservative Count

For currently open `P0`/`P1` issues with a clear or likely PR-caused chain:

- Jinwoo: 1 confirmed open `P0` regression chain.
- Brennan: 1 likely open `P0` regression chain.
- Neil: 0 confirmed open `P0`/`P1` chains from the evidence pulled, plus 1 confirmed closed `P1` chain.

Most open `P0`/`P1` issues do not identify an introducing PR. Treating those as individual blame would be misleading. The stronger conclusion is that Orca has systemic reliability gaps around terminal/session lifecycle, provider contracts, PTY sizing, and upgrade/startup flows.

## Recommended Next Steps

Implementation plan: [`docs/reference/reliability-gates-implementation-plan.md`](./reliability-gates-implementation-plan.md).

1. Deduplicate and update `P0` issues #6873/#6874 and #6773 with the suspected fix status.
2. Add narrow red/green gates for known escapes first: newborn liveness race, PTY `0x0`, xterm addon throw containment, old-version upgrade fixture, and Linux Wayland render-live/input-live smoke.
3. Define test maturity levels, promotion records, numeric flake/demotion policy, and a reliability-gates manifest before making new reliability gates blocking.
4. Build the fake/fault-injection provider contract kit, then run the same contract against local and daemon PTY before expanding to SSH, WSL, remote runtime, and mobile.
5. Add upgrade/startup/release fixtures for pre-#5232 session data, stale daemon/helper paths, packaged app reveal/close, nested notarization, PATH probe timeout, and Windows terminal activation.
6. Add the terminal lifecycle state machine design doc and implement it incrementally behind the known escaped-regression gates.
7. Formalize the PTY size protocol and make `0x0` a quarantined/non-authoritative state for visible panes.
8. Add the agent identity contract for pane reuse, worktree switch, sidebar/mobile rows, provider session ids, stale notifications, and ownership-safe provider session replay across active/inactive tabs, visible/hidden panes, repeated activation, and live/quit/worktree-sleep records.
9. Add performance budgets and measurements to reliability gates that touch terminal throughput, hidden panes, store subscribers, persistence, startup, polling, subprocess churn, git/worktree scans, cleanup modals, SSH/WSL git providers, or Windows git crash risk.
10. Gate terminal/session PRs behind the reliability checklist above, including perf and git crash/perf checks when those surfaces are touched.
11. Keep the factory skill update as the enforcement layer, add the Playwright reliability-testing skill, and make `perf` plus `git-crash-perf` mandatory companion skills for relevant PRs; then revise companion skills once exact repo commands and CI job names exist.
12. Add pane lifecycle traces so future issues can be attributed from evidence instead of archaeology.
