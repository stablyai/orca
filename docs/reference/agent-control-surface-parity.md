# Agent Control Surface Parity

Tracking issue: [stablyai/orca#5700](https://github.com/stablyai/orca/issues/5700)

Split workstream issues: [#5702](https://github.com/stablyai/orca/issues/5702), [#5703](https://github.com/stablyai/orca/issues/5703), [#5704](https://github.com/stablyai/orca/issues/5704), [#5705](https://github.com/stablyai/orca/issues/5705), [#5706](https://github.com/stablyai/orca/issues/5706), [#5707](https://github.com/stablyai/orca/issues/5707), [#5708](https://github.com/stablyai/orca/issues/5708), and [#5709](https://github.com/stablyai/orca/issues/5709).

Agent Control Surface Parity means Orca exposes the control surfaces that agents need to operate Orca itself: stable target discovery, deterministic selectors, executable commands or runtime methods, structured success and failure output, and verifiable resulting state.

This is capability parity for agent operation. It is narrower than full product parity with Claude Code, Codex, Droid, Gemini, OpenCode, Grok, or Cursor Agent. It is broader than UI discoverability work.

A surface reaches parity when an agent can:

- discover the capability from checked-in skills, CLI help, MCP/tool schema, or runtime capability output;
- select the intended target without UI focus or hidden IDs;
- execute the action through an Orca-owned CLI, skill, MCP, or runtime surface;
- receive structured output for success, partial success, and failure;
- verify the resulting state through semantic state where available;
- behave safely across local, SSH, remote runtime, paired mobile, and restarted-session cases where the underlying feature supports those modes.

## Why `affordance controls` is the wrong title

In Orca planning, `affordance` should mean UI discoverability for humans: visible controls, labels, hover or focus states, tooltips, tours, and other cues that show a user that a feature exists.

That is useful, but it is the wrong name for this initiative. The parity gap is whether an agent can operate Orca reliably. A button, tooltip, badge, tour, or display-name label does not create agent-operable capability by itself. The durable requirement is a stable command or runtime surface that lets an agent target, act, and verify without manual UI bridging.

Use these terms consistently:

- **Control surface**: agent-operable API, command, skill, MCP tool, or runtime method.
- **Affordance**: human-facing UI discoverability for an already available action.
- **Feature discovery tracking**: local education state that records whether a user found or used a feature. It is evidence for onboarding, not a parity deliverable.

## Incumbent baseline taxonomy

The incumbent harness baseline is capability-based rather than brand-based. Orca should not clone every provider-specific feature. It should expose the common control surfaces agents expect from modern harnesses.

| Capability area | Incumbent baseline | Orca parity test |
|---|---|---|
| Session continuity | Claude Code, Codex, Droid, Gemini, OpenCode, and Grok all expose session resume. Stronger surfaces also support fork, branch, checkpoint, archive, delete, share, export, or rewind. | Can Orca persist and resume the exact provider session for a sleeping agent, using provider session identity instead of terminal layout alone? |
| Lifecycle hooks and extension events | Incumbents expose session, prompt, permission, tool, subagent, file, worktree, compact, notification, or plugin events with trusted configuration. | Can Orca capture agent lifecycle state and expose hook status, provider session metadata, and event outcomes as structured state? |
| Permissions, approvals, and sandbox policy | Codex and Claude emphasize sandbox plus approvals. Droid uses autonomy tiers. Gemini and Grok expose plan or always-approve modes. OpenCode has granular permission rules. | Can Orca distinguish setup-needed, denied, unsupported, experimental, and ready states without requiring UI inspection? |
| Tool, browser, computer, and MCP operability | MCP, plugins, shell, file tools, web fetch/search, and custom tools are table stakes. Browser or desktop control is often provided through MCP/plugins, while some harnesses provide dedicated computer surfaces. | Can Orca expose embedded browser, desktop Computer Use, emulator, and MCP-adjacent surfaces through stable selectors and structured failure modes? |
| Terminal, workspace, and worktree control | All incumbents are terminal-first. Most support cwd control, writable roots, worktrees, sandboxed roots, headless runs, or protocol servers. | Can Orca manage worktrees, terminals, files, panes, and agent launches without relying on active UI focus? |
| Account, auth, usage, and billing visibility | Droid, Gemini, OpenCode, and Grok expose explicit account or usage commands. Codex has login, doctor, and model diagnostics. Claude exposes auth/settings/context surfaces. | Can Orca expose active provider identity, account switching where supported, usage, stats, and auth/setup failures as agent-readable state? |
| Review, CI, and external handoff | Claude, Codex, Droid, Gemini, OpenCode, and Grok all support review or headless automation patterns. | Can Orca expose review notes, diff targets, commit/PR actions, issues, automations, and handoff state without pixel-only interpretation? |
| Mobile, web, and remote operation | Claude has web plus mobile monitoring. OpenCode supports web/mobile backend access. Codex supports app-server and cloud tasks. Droid supports BYOM/daemon/Slack. | Can Orca preserve the same semantics through mobile RPC, SSH worktrees, remote runtimes, and restarted sessions where those features are enabled? |

## Current Orca control surface matrix

Status values:

- **Implemented**: agent-operable surface exists with meaningful CLI/runtime coverage.
- **Partial**: surface exists, but has a targeting, completeness, flag, provider, remote, or documentation gap.
- **Gap**: expected control surface is missing or only exists as UI discoverability.

The sourced Orca artifacts show many implemented surfaces and several partial surfaces. This document does not classify any surface as a pure gap unless the action is absent or UI-only; the current gaps are called out in the Partial column.

| Orca surface | Status | Implemented today | Partial or gap |
|---|---:|---|---|
| Worktrees and workspaces | Implemented | `orca worktree` and workspace concepts support list/show/current/create/set/remove, parent lineage, setup policy, agent launch, prompts, issue links, Linear/project host setup, repo targeting, and comments/status in current CLI surfaces. | Selector consistency still needs hardening across every command that targets worktrees, workspaces, repos, or sessions. `name:<displayName>` belongs here as one foundational selector slice. |
| Terminals, panes, and splits | Implemented | Agents can list/show/read/send/wait/stop/create/split/rename/switch/close terminals, use cursor reads, wait for exit or `tui-idle`, and recover stale terminal handles. | Pane nesting, sibling-agent addressing, and copyable terminal/pane IDs are related targeting work. See [#5443](https://github.com/stablyai/orca/issues/5443). |
| Embedded browser control | Implemented | Orca exposes browser navigation, snapshots, screenshots, element actions, fill/type/select/upload, waits, JavaScript eval, tabs, profiles, cookies, storage, console/network capture, viewport/geolocation/media/offline settings, downloads, highlighting, and advanced actions. | Browser control needs deterministic page targeting, stale-ref recovery, and completion of request interception semantics. Direct `agent-browser` style control is tracked separately from Orca CLI browser commands. See [#5610](https://github.com/stablyai/orca/issues/5610) and [#5112](https://github.com/stablyai/orca/issues/5112). |
| Browser cookies and profiles | Partial | CLI surfaces can manage cookies and profiles, and runtime surfaces support profile list/create/delete plus browser import/detection behavior. | Public CLI coverage for importing cookies from installed browsers appears incomplete relative to runtime capability. The docs should state whether import is UI/runtime-only or expose a CLI path. |
| Desktop Computer Use | Implemented | CLI/runtime support capabilities, app/window listing, permission checks, app state snapshots, click, secondary action, scroll, drag, type, key, hotkey, paste, and set-value. | Permission/setup failures and cross-platform limitations should be structured so agents can distinguish setup-needed from unsupported platform and stale window. |
| Inter-agent orchestration | Partial | Orca has structured messages, inbox/check/reply/ask, dispatch, tasks, worker lifecycle, decision gates, coordinator loops, and group addressing. | The orchestration surface is experimental and should be treated as implemented behind a flag until readiness, validation, and restart-resume semantics are hardened. |
| Automations and scheduled runs | Implemented | Agents can list/show/create/edit/remove/run automations with schedule presets, cron/RRULE, provider, precheck, repo/workspace/project-host targets, and run history. | Existing-workspace reuse needs a defined relationship to durable provider-session resume. Failure output should identify target, schedule, precheck, provider, and launch-command causes. |
| Provider accounts and usage | Partial | Runtime/mobile surfaces expose account list/select/remove for Claude/Codex and stats summaries. Feature tracking covers provider usage for Claude, Codex, OpenCode, Gemini and account switching for Claude/Codex. | No public CLI account/stats command coverage was identified. Interactive add/reauth remains desktop-owned. |
| Agent hooks and live status | Implemented | CLI can toggle hook status, runtime ingests hook payloads, and current hook types carry provider session metadata through local and SSH relay envelopes. | Hook readiness should be included in capability discovery and setup diagnostics so agents can tell whether status is authoritative. |
| Exact provider-session resume | Partial | Current shared code extracts provider session data and maps resume commands for first-tier agents including Claude, Codex, Gemini, Antigravity, OpenCode, Droid, Grok, and Devin. Workspace session schema persists sleeping agent records with provider session fields. | Cursor, Pi/OMP, Amp, Hermes, Copilot, and Command Code remain unsupported or unverified. Resume must surface provider CLI failure and keep records until explicit dismissal. See [#1796](https://github.com/stablyai/orca/issues/1796), [#5045](https://github.com/stablyai/orca/issues/5045), [#5240](https://github.com/stablyai/orca/issues/5240), [#5633](https://github.com/stablyai/orca/issues/5633), and related provider-specific follow-ups. |
| SSH and remote runtimes | Implemented | Orca supports SSH worktrees, remote file editing, git, terminals, auto-reconnect, port forwarding, project host setup, runtime serving over LAN/Tailscale/SSH/public tunnel, environment records, and SSH runtime state. | Some clone/setup flows remain desktop-owned. Selector defaults must avoid resolving local `active/current/path:` shortcuts against the wrong remote runtime. |
| Mobile supervision | Implemented | Mobile RPC allowlists terminals, sessions, browser navigation/screencast/input, files, notifications, status, SSH state/connect, stats, settings, repo, preflight, accounts, and session tabs through token-scoped runtime access. | Mobile is intentionally scoped by allowlist. Capability discovery should make unsupported methods explicit rather than relying on forbidden-method errors. |
| Emulator control | Implemented | Workspace-scoped emulator commands support list, attach, tap, type, gesture, button, rotate, exec, kill, and shutdown, backed by runtime state. | Stale device handling and worktree/device selector behavior should use the same structured error vocabulary as other targetable surfaces. |
| Feature discovery and education | Partial | Feature tracking records first meaningful interaction and local counts for education-targeted features, including browser setup/use, computer use, orchestration, automations, SSH, usage, account switching, panes/splits, notifications, and workspace surfaces. | The implemented portion is UI telemetry, not control-surface parity. Do not count tours, tips, labels, or interaction counters as parity unless the underlying action is agent-operable. |
| Runtime capability discovery | Partial | Some surfaces expose status or capabilities, such as computer capabilities, hook status, environment status, account/stats runtime methods, and CLI help. | Orca needs a consolidated agent-readable capability model across worktree, terminal, browser, computer, emulator, orchestration, automations, hooks, environments, accounts, mobile, and remote runtime setup. |

## Ordered workstreams

### 1. Stable agent addressing and selector grammar

Every other surface depends on stable targeting. Agents need to address repos, worktrees, terminals, panes, browser pages, emulator instances, desktop windows, automations, orchestration tasks, and provider sessions without relying on UI focus.

`name:<displayName>` selector work is the first foundational slice here. It is not the full milestone.

Definition of done:

- `name:<displayName>` is supported wherever worktree selectors are accepted and can resolve to one stable object.
- Ambiguous names return deterministic errors with suggested `id:` alternatives.
- Selector behavior is consistent across worktree, terminal, browser, file, emulator, computer, automation, and orchestration commands where those commands accept targets.
- Remote runtime safety is preserved. `active:`, `current:`, and path-derived shortcuts never silently resolve against the wrong machine.
- CLI help and skills use one vocabulary for selectors and ambiguity recovery.

Immediate slices:

1. Audit every `--worktree`, `--workspace`, `--repo`, `--terminal`, `--page`, `--session`, `--device`, and orchestration target flag.
2. Implement `name:<displayName>` only in resolver layers that can return stable IDs.
3. Standardize `selector_ambiguous` and `selector_not_found` errors.
4. Update skill/help examples to use `name:` where it is safe and `id:` where ambiguity matters.

Related issues and PRs: [#5443](https://github.com/stablyai/orca/issues/5443), [#5695](https://github.com/stablyai/orca/issues/5695), [#5696](https://github.com/stablyai/orca/pull/5696).

### 2. Durable agent session lifecycle and exact resume

Terminal layout is insufficient for exact resume. Orca needs durable provider session metadata that survives sleep, wake, remote relay, and runtime restarts.

Definition of done:

- Provider session metadata is extracted before hook normalization and carried through local and SSH hook envelopes.
- Sleeping-agent records persist provider, provider session kind/value, cwd, agent type, prompt/assistant preview, timestamps, retention metadata, and structured resume argv.
- Sleep snapshots live agent status before dropping status by worktree.
- Wake launches exactly one provider-specific resume process per sleeping record, with duplicate-click and race protection.
- Verified providers resume exactly. Unsupported providers surface explicit unsupported states.
- Failed provider resume surfaces the CLI failure and keeps the record until explicit dismissal.

Immediate slices:

1. Keep the verified provider argv map tight: Claude, Codex, Gemini, Antigravity, OpenCode, Droid, Grok, and Devin where current code supports them.
2. Gate Cursor, Pi/OMP, Amp, Hermes, Copilot, and Command Code until provider IDs and resume commands are verified.
3. Ensure resume errors are structured and actionable.

Related issues and PRs: [#1796](https://github.com/stablyai/orca/issues/1796), [#5045](https://github.com/stablyai/orca/issues/5045), [#5240](https://github.com/stablyai/orca/issues/5240), [#5633](https://github.com/stablyai/orca/issues/5633).

### 3. Workspace, repo, file, and terminal command parity

Agents need deterministic control over the working set: create worktrees, launch agents, read/send/wait terminals, inspect changed files, and focus/open the right context.

Definition of done:

- Agents can list, show, create, set, remove, comment on, and link issues to worktrees with stable selectors.
- Agents can launch a named provider in a selected worktree with an initial prompt and know whether setup ran, skipped, or failed.
- Agents can create terminals in existing worktrees, split/focus/switch/close panes, read bounded output with cursors, send input, interrupt, stop worktree terminals, and wait for exit or `tui-idle`.
- Agents can open files, diffs, and changed files in the editor without relying on active UI focus.
- Stale terminal handles return reacquire guidance.

Immediate slices:

1. Compare skill command coverage against CLI specs for worktree, terminal, and file commands.
2. Add stable target resolution where commands still depend on active UI defaults.
3. Normalize terminal read/wait/send responses around cursor, latest output, stale handle, and `tui-idle` semantics.

Related issues: [#5443](https://github.com/stablyai/orca/issues/5443), [#5696](https://github.com/stablyai/orca/pull/5696).

### 4. Embedded browser operation parity

Orca already has broad embedded browser control. The workstream is about completeness, determinism, and page-addressable operation.

Definition of done:

- Agents can target tabs/pages/profiles by stable selectors.
- Agents can navigate, snapshot, screenshot, inspect state, click, double-click, hover, drag, fill, type, select, upload, press keys, scroll, wait, and evaluate JavaScript.
- Agents can manipulate cookies, storage, headers, HTTP auth, geolocation, media, offline mode, clipboard, dialogs, downloads, console/network capture, and highlighting.
- Request interception either supports per-request continue/block/fulfill decisions or states non-support explicitly.
- Browser refs, pages, profiles, and stale-ref errors are machine-readable.

Immediate slices:

1. Inventory browser-basic and browser-advanced specs against the Orca CLI skill.
2. Resolve request interception semantics so agents are not handed an incomplete surface.
3. Standardize browser errors such as `browser_no_tab`, `browser_stale_ref`, `browser_tab_not_found`, and missing profile.

Related issues: [#5112](https://github.com/stablyai/orca/issues/5112), [#5610](https://github.com/stablyai/orca/issues/5610), [#5696](https://github.com/stablyai/orca/pull/5696).

### 5. Desktop Computer Use and emulator control parity

Browser control does not cover native apps, OS dialogs, simulator apps, or visible UI outside Orca's embedded browser.

Definition of done:

- Agents can list apps/windows, inspect permissions/capabilities, capture compact app state, and perform desktop actions with stable app/window/session targeting.
- Permission/setup states are explicit in CLI/runtime output.
- Emulator commands are addressable by worktree, device, and emulator ID.
- Platform limitations are structured capability data.

Immediate slices:

1. Audit Computer Use and emulator specs for missing capability probes and stale-target errors.
2. Align computer-use selectors with the selector grammar from Workstream 1.
3. Distinguish setup-needed, unsupported-platform, permission-denied, and stale-window failures.

Related issue: [#2026](https://github.com/stablyai/orca/issues/2026).

### 6. Structured multi-agent orchestration parity

Orca's differentiator is coordinating many agents. That needs typed coordination surfaces rather than terminal text scraping.

Definition of done:

- Agents can send, reply, check, inbox, and ask with threaded messages, groups, priorities, types, and payload metadata.
- Coordinators can create/list/update tasks, dispatch to terminals, inspect dispatches, run/stop loops, and manage decision gates.
- Worker completion authority is unambiguous through structured `worker_done`, heartbeat, escalation, files-modified, report path, task ID, and dispatch ID fields.
- Group messages do not accidentally create lifecycle events for unrelated workers.
- Dispatch and task state survives CLI/runtime restart well enough for coordinators to resume without scraping terminal output.

Immediate slices:

1. Diff orchestration skill guidance against CLI specs and move behavior that exists only as prose into validation or typed flags where possible.
2. Make worker lifecycle fields first-class command parameters.
3. Add structured task/dispatch state responses suitable for restart recovery.

Related issues: [#5443](https://github.com/stablyai/orca/issues/5443), [#5696](https://github.com/stablyai/orca/pull/5696).

### 7. Automations and scheduled agent runs

Recurring or event-triggered agent work needs inspectable, repairable run state.

Definition of done:

- Agents can list, show, create, edit, remove, run, and inspect automation runs.
- Automations can target repo-created worktrees, existing workspaces, projects/hosts, or project-host setups.
- Schedules support presets, cron/RRULE, timezone, time/day, prechecks, source context, enabled state, and fresh/reuse-session semantics.
- Existing-workspace `--reuse-session` integrates with durable session lifecycle where possible and falls back predictably.
- Run failures identify target, provider, precheck, schedule, setup, and launch causes.

Immediate slices:

1. Verify automation skill guidance matches CLI spec flags and examples.
2. Define how `--reuse-session` interacts with sleeping-agent resume records.
3. Ensure run history records target, provider, reuse/fresh decision, precheck result, launch command, terminal handle, and session handle.

Related issues and PRs: [#1796](https://github.com/stablyai/orca/issues/1796), [#5045](https://github.com/stablyai/orca/issues/5045), [#5240](https://github.com/stablyai/orca/issues/5240).

### 8. Capability discovery, setup diagnostics, and self-description

Agents need to discover what Orca can do at runtime across versions, operating systems, permissions, remote runtimes, and experimental flags.

Definition of done:

- Status/capability commands expose readiness for runtime, worktree, terminal, browser, computer, emulator, orchestration, automations, hooks, environments, accounts, mobile, and SSH.
- Setup-needed states are agent-readable and include next actions.
- Feature discovery tracking remains local education state only.
- Public skills are audited against command specs so instructions do not drift from implementation.

Immediate slices:

1. Create a capability matrix from existing CLI specs and status commands.
2. Normalize JSON capability responses for surfaces currently requiring prose or UI inspection.
3. Add a docs/spec audit that flags drift between skills and CLI specs.

Related issues: [#4376](https://github.com/stablyai/orca/issues/4376), [#4419](https://github.com/stablyai/orca/issues/4419).

## Non-goals

- Full product parity with every incumbent agent harness.
- Recreating every provider-specific feature from Claude Code, Codex, Droid, Gemini, OpenCode, Grok, Cursor Agent, or any other provider.
- Counting UI polish, tours, tooltips, labels, badges, or visible buttons as control-surface parity.
- Expanding feature discovery or education telemetry as a parity deliverable.
- Pixel-only automation for workflows that can expose semantic state.
- Compatibility shims that leave two long-term ways to perform the same Orca-owned action.
- Promising exact resume for providers whose session IDs and resume commands are not verified.
- Treating `name:<displayName>` selectors as the whole initiative.

## Immediate first slices

These slices are ordered to unlock later work without overclaiming completion:

1. **Named selector groundwork**: land `name:<displayName>` for unambiguous worktree selection, with stable-ID fallback and structured ambiguity errors. This supports the broader selector grammar but does not complete it.
2. **Targeting inventory**: classify every target flag and handle as stable, transient, active/current-only, UI-only, or missing across worktree, terminal, browser, file, emulator, computer, automation, and orchestration commands.
3. **Exact resume hardening**: keep verified provider resume support explicit, keep unsupported providers gated, and require structured resume failures that preserve records.
4. **Browser surface cleanup**: resolve request interception semantics and normalize browser target/stale-ref errors.
5. **Capability discovery pass**: expose readiness and setup-needed state for hooks, browser, computer use, orchestration, emulator, SSH/remote runtime, account usage, and mobile allowlisted methods.
6. **Skill/spec drift audit**: make `orca-cli`, orchestration, computer-use, and emulator guidance match command specs, especially selectors, target defaults, and structured errors.

## Related issues

- [#5702](https://github.com/stablyai/orca/issues/5702): stable selectors and target addressing.
- [#5703](https://github.com/stablyai/orca/issues/5703): durable session lifecycle and exact resume.
- [#5704](https://github.com/stablyai/orca/issues/5704): workspace, file, and terminal command parity.
- [#5705](https://github.com/stablyai/orca/issues/5705): embedded browser operation parity.
- [#5706](https://github.com/stablyai/orca/issues/5706): desktop Computer Use and emulator control.
- [#5707](https://github.com/stablyai/orca/issues/5707): structured multi-agent orchestration.
- [#5708](https://github.com/stablyai/orca/issues/5708): automations and scheduled agent runs.
- [#5709](https://github.com/stablyai/orca/issues/5709): capability discovery and setup diagnostics.
- [#5695](https://github.com/stablyai/orca/issues/5695): worktree `name:<displayName>` selector bug used as the first stable-selector slice.
- [#5696](https://github.com/stablyai/orca/pull/5696): PR fixing `name:<displayName>` worktree selector resolution.
- [#4376](https://github.com/stablyai/orca/issues/4376): improved orchestration and worker status signaling.
- [#4419](https://github.com/stablyai/orca/issues/4419): agent-addressable resource URLs and deep links.
- [#2026](https://github.com/stablyai/orca/issues/2026): agent session forking and context branching.
- [#5443](https://github.com/stablyai/orca/issues/5443): terminal IDs, pane nesting, and sibling-agent communication.
- [#5112](https://github.com/stablyai/orca/issues/5112): Orca CLI browser-use discoverability and auto-triggering.
- [#5610](https://github.com/stablyai/orca/issues/5610): direct `agent-browser` style control of Orca browser tabs.

## Maintenance rules

- Keep this document capability-based. Add provider names only as examples or verification boundaries.
- Update status from **Partial** to **Implemented** only when an agent can discover, target, execute, and verify the capability without UI-only bridging.
- Keep affordance work in the UI/discovery lane unless it is paired with a stable command or runtime method.
- Prefer structured error names and stable selectors over prose-only instructions.
- When a workstream changes CLI behavior, update the matching skill text and reference docs in the same branch.
