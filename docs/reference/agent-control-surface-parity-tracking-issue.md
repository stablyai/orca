Issue title: [Feature]: Agent Control Surface Parity
Labels: enhancement, agent-workflow, P1
Published issue: https://github.com/stablyai/orca/issues/5700
Split workstream issues: #5702, #5703, #5704, #5705, #5706, #5707, #5708, #5709

## Summary

Track Agent Control Surface Parity for Orca: make high-value Orca workflows discoverable, targetable, executable, and verifiable by agents through stable Orca-owned CLI, skill, MCP, or runtime surfaces.

This is narrower than full product parity with Claude Code, Codex, Droid, Gemini, OpenCode, Grok, Cursor Agent, or any other harness. It is also broader than UI affordance work. In this issue, **affordance** means human-facing UI discoverability: labels, icons, hover or focus states, and tooltips. Control-surface parity means an agent can operate the capability without asking the user to bridge hidden IDs, UI-only controls, or missing verification steps.

## Why this matters

Orca already presents itself as an orchestrator for multiple CLI agents and exposes real agent-operable surfaces: worktrees, terminals, embedded browser tabs, desktop Computer Use, orchestration, automations, hooks, remote runtimes, mobile supervision, and emulator control.

Users will still compare Orca to incumbent harnesses by asking whether their agents can operate the environment as reliably as they can. A feature can exist in the UI and still fall short for agents if it lacks stable selectors, explicit target resolution, structured errors, remote-safe defaults, or machine-readable verification.

The initiative should therefore distinguish:

- implemented Orca surfaces that already have agent-operable commands or runtime methods;
- partial surfaces where the feature exists but CLI, selector, provider, or capability coverage is incomplete;
- parity gaps where agents must still infer state from UI focus, prose, pixels, or manual user intervention.

## Definition of done

An Orca workflow reaches Agent Control Surface Parity when an agent can:

- [ ] Discover that the capability exists from a skill, CLI help, MCP/tool schema, runtime capability probe, or prompt preamble.
- [ ] Select the correct target with stable IDs or documented selectors, including explicit selectors when the active pane, tab, worktree, or session is not the right target.
- [ ] Execute the action through a stable command, MCP/tool call, or runtime method.
- [ ] Receive structured success and failure output, including ambiguity, stale handle, unsupported platform, permission needed, and setup needed states.
- [ ] Verify the resulting state through semantic output rather than pixels, except where pixels are the product state.
- [ ] Use active/current defaults safely, with documented behavior in local, SSH, remote runtime, paired mobile, and restarted-session cases where the feature supports those modes.
- [ ] Avoid unsafe side effects unless the command is explicitly named, scoped, and confirmable where needed.

## Scoped checklist

### 1. Inventory and classification

- [ ] Build a capability matrix across common agent-harness expectations: session continuity, hooks, permissions, tool/browser/computer operability, terminal/workspace control, account and usage visibility, review/CI handoff, mobile/web/remote operation, and orchestration.
- [ ] Keep the matrix capability-based rather than vendor-copy based. Example: "send input to a named agent session" instead of "match Claude Code exactly."
- [ ] Mark each Orca capability as implemented, partial, UI-only, missing targeting, missing verification, missing public CLI surface, or documentation/skill trigger gap.
- [ ] Link each row to its owning Orca surface: worktree, terminal, browser, computer use, orchestration, automation, source control/review, GitHub/Linear/Jira, mobile, emulator, notification, account, hook, setting, or runtime environment.

### 2. Stable addressing and selectors

- [ ] Treat `name:<displayName>` selector support as foundational selector work, not the full Agent Control Surface Parity milestone.
- [ ] Ensure every agent-operable object has a stable handle or documented selector: repo, worktree, terminal, pane, tab, browser page, profile, automation, task, issue/PR, comment, diff range, emulator, desktop app/window, and agent session.
- [ ] Make selector ambiguity deterministic, with machine-readable errors and suggested stable `id:` alternatives.
- [ ] Preserve remote runtime safety so cwd-derived active/current/path shortcuts do not silently resolve against the wrong machine.
- [ ] Publish shared selector vocabulary in CLI help and skills wherever commands accept worktree, workspace, terminal, page, session, device, or orchestration targets.

### 3. Implemented surfaces to keep stable

- [ ] Preserve existing worktree/workspace command coverage: list, show, current, create, set metadata, remove, process inspection, issue links, setup policy, parent lineage, and agent launch.
- [ ] Preserve existing terminal command coverage: list, show, read with cursors and limits, send, wait, stop, create, split, rename, switch, close, and `tui-idle` waiting.
- [ ] Preserve embedded browser control: navigation, snapshots, screenshots, element actions, tabs/profiles, cookies, console/network capture, waits, JavaScript evaluation, storage, downloads, dialogs, viewport/device/media settings, highlighting, and stale-ref recovery.
- [ ] Preserve desktop Computer Use coverage: app/window listing, permission/capability checks, app state snapshots, click, secondary action, scroll, drag, type, key, hotkey, paste, and set-value.
- [ ] Preserve automation coverage: list, show, create, edit, remove, run, run history, schedule presets, cron/RRULE, timezone/time/day, provider, precheck, and fresh versus reuse-session semantics.
- [ ] Preserve remote and mobile supervision boundaries: SSH/runtime environments, `orca serve`, mobile allowlisted RPC methods, device tokens, and intentional method restrictions.
- [ ] Preserve emulator coverage: list, attach, tap, type, gesture, button, rotate, exec, kill, and shutdown with worktree/device scoping.

### 4. Known parity gaps and partial surfaces

- [ ] Close or explicitly document public CLI gaps for provider accounts and usage visibility where runtime/mobile methods exist but CLI specs do not expose equivalent agent-facing commands.
- [ ] Close or explicitly document cookie import/profile import gaps where runtime/UI can detect or import installed browser cookies but the public CLI profile surface does not yet expose the same path.
- [ ] Treat orchestration as implemented behind an experimental setting until setup, capability detection, and failure states are agent-readable.
- [ ] Treat exact session resume as partial across providers: verified resumable agents should work through durable provider-session records, while Cursor, Pi/OMP, Amp, Hermes, Copilot, Command Code, and other unverified providers should stay gated or clearly unsupported until their IDs and resume commands are proven.
- [ ] Resolve browser request interception semantics by either supporting per-request continue/block/fulfill decisions or documenting the unsupported state so agents are not handed a dead-end surface.
- [ ] Add capability probes for setup-needed and permission-needed states across hooks, browser control, Computer Use, orchestration, SSH/remote runtime, accounts/providers, mobile, and emulator.

### 5. Browser and Computer Use boundaries

- [ ] Keep Orca embedded browser control separate from external desktop app control.
- [ ] Track direct `agent-browser` integration separately from Orca CLI browser commands.
- [ ] Define how agents discover and target Orca browser tabs from local, SSH, and remote runtime contexts.
- [ ] Use Computer Use for desktop app accessibility and screenshots, not as a substitute for semantic browser commands when an Orca browser command exists.

### 6. Terminals, sessions, and orchestration

- [ ] Expose terminal IDs, pane IDs, visual grouping, and parent/child workspace relationships in ways agents can list, copy, and select.
- [ ] Support sending text or prompts to a selected agent session rather than only the focused terminal.
- [ ] Expose agent status, running/done/blocked state, prompt metadata, unread/attention state, and stale-handle recovery in structured output.
- [ ] Keep structured orchestration commands distinct from raw terminal send/read commands.
- [ ] Ensure group messages cannot accidentally create lifecycle events for unrelated workers.

### 7. Worktrees, automations, review, and source control

- [ ] Ensure agents can create, list, inspect, comment on, and remove Orca-managed worktrees with stable selectors.
- [ ] Ensure agents can launch a selected provider in a worktree and know whether setup hooks ran, skipped, or failed.
- [ ] Clarify how recurring automation runs choose a new worktree versus reuse an existing workspace or resumable session.
- [ ] Expose review notes, diff targeting, send-to-agent, commit, PR, and issue actions through agent-operable surfaces where safe.
- [ ] Ensure agents can identify which diff they are viewing: branch, working tree, last turn, PR, or selected comparison.
- [ ] Keep destructive Git and workspace actions explicit and confirmable where needed.

### 8. Documentation, skills, prompts, and UI affordances

- [ ] Update `orca-cli`, `computer-use`, `orchestration`, emulator, and related skills when commands, selectors, or setup paths change.
- [ ] Update public docs when setup, remote behavior, or agent discoverability changes.
- [ ] Add trigger guidance so agents naturally choose Orca CLI, browser, Computer Use, orchestration, or emulator commands when operating inside Orca.
- [ ] Use UI affordances as a supporting track for human discoverability after the underlying action has a clear agent-operable shape or a deliberate human-only decision.
- [ ] Do not count a tooltip, tour, label, button, or local feature-discovery event as control-surface parity by itself.

## Suggested first slices

- [ ] Inventory existing Orca command, skill, and runtime coverage against the scoped checklist above.
- [ ] Land stable named selector groundwork, including `name:<displayName>` where resolver layers can return unambiguous stable IDs.
- [ ] Resolve targeting gaps for terminal IDs, pane nesting, and agent-session selection.
- [ ] Resolve browser-control discoverability, including Orca CLI auto-triggering and the direct `agent-browser` path.
- [ ] Update skills and docs to separate UI affordance, setup, and successful runtime use.

## Related issues and PRs

- #5112: Orca CLI browser use should auto-trigger instead of requiring users to explicitly instruct the AI to use Orca CLI.
- #5443: Agents need terminal IDs and pane nesting/grouping IDs for sibling-agent communication.
- #5610: Agents with `agent-browser` workflows expect direct control of Orca browser tabs in addition to Orca CLI browser commands.
- PR #2734: Separates feature education and discovery from actual feature interaction state, including browser, Computer Use, and orchestration signals.

## Non-goals

- Full product parity with every incumbent agent harness.
- Recreating every provider-specific feature from Claude Code, Codex, Droid, Gemini, OpenCode, Grok, Cursor Agent, or any other agent.
- Treating `name:<displayName>` selector support as the entire initiative.
- UI polish without an agent-operable capability behind it.
- Pixel-only automation for workflows that can expose semantic state.
- Broad claims that agents can control everything in Orca before each listed surface has stable targeting, execution, errors, and verification.
- Long-term compatibility shims that leave two Orca-owned ways to do the same action without a clear migration path.

## Split workstream issues

- [ ] #5702: Stable selectors and target addressing.
- [ ] #5703: Durable session lifecycle and exact resume.
- [ ] #5704: Workspace, file, and terminal command parity.
- [ ] #5705: Embedded browser operation parity.
- [ ] #5706: Desktop Computer Use and emulator control.
- [ ] #5707: Structured multi-agent orchestration.
- [ ] #5708: Automations and scheduled agent runs.
- [ ] #5709: Capability discovery and setup diagnostics.
