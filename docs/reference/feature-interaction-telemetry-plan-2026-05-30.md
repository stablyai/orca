# Feature Interaction Telemetry Plan

Date: 2026-05-30

## Status

Planning only. Do not implement new telemetry from this document until the product, privacy, and volume gates below are accepted.

Correction after code review: the first draft over-modeled feature exposure/dismissal as if Orca had one universal feature-education surface. It does not. Orca exposes features through several different surfaces, and it already has a central local feature-interaction system for actual use. The telemetry plan should use that real system.

Gate decision: conditionally passes for a top-coded feature-usage bucket event backed by existing `recordFeatureInteraction(...)` writers. Do not add broad passive exposure telemetry, do not add a universal dismissal model, and do not emit every interaction.

## Source Context

Requested but not present at the expected paths in this worktree:

- `docs/reference/onboarding-retention-improvement-plan-2026-05-23.md`
- `docs/reference/orca-retention-levers-report.md`
- `docs/reference/retention-dropoff-archetype-split-2026-05-29.md`

Code and docs read for this plan:

- `docs/reference/feature-discovery-interaction-tracking.md`
- `docs/reference/telemetry-availability.md`
- `src/shared/feature-interactions.ts`
- `src/shared/feature-tips.ts`
- `src/shared/telemetry-events.ts`
- `src/renderer/src/lib/telemetry.ts`
- `src/renderer/src/store/slices/ui.ts`
- `src/main/persistence.ts`
- `src/main/runtime/rpc/dispatcher.ts`
- `src/renderer/src/components/feature-tips/FeatureTipsModal.tsx`
- `src/renderer/src/components/feature-tips/feature-tip-startup-gate.ts`
- `src/renderer/src/components/sidebar/SetupScriptPromptCard.tsx`
- `src/renderer/src/components/WorktreeJumpPalette.tsx`
- `src/renderer/src/components/cmd-j/quick-actions.ts`
- `src/renderer/src/store/slices/browser.ts`
- `src/renderer/src/store/slices/editor.ts`
- Feature-wall, onboarding setup, settings, browser, workspace board, runtime RPC, dictation, and status-bar `recordFeatureInteraction(...)` call sites found by `rg`.
- Reference OSS telemetry patterns reviewed for the shape of product events: typed schemas, explicit user actions/outcomes, low-cardinality properties, and top-coded frequency buckets rather than unbounded usage counters.

## What The Code Actually Does

Orca already has a local feature-usage catalog:

- `src/shared/feature-interactions.ts` defines `FeatureInteractionId`.
- `PersistedUIState.featureInteractions` stores `firstInteractedAt` and `interactionCount`.
- `src/renderer/src/store/slices/ui.ts` increments local state through `recordFeatureInteraction(id)`.
- `src/main/persistence.ts` also increments the persisted state through `Store.recordFeatureInteraction(id)`.
- Renderer UI actions, settings panes, status-bar controls, workspace board actions, browser actions, dictation, automation actions, and runtime RPC methods already call `recordFeatureInteraction(...)`.
- `src/shared/feature-interactions.test.ts` enforces that every catalog id has a production writer.

That is the right backbone for feature usage. The new telemetry should not invent a second feature-use taxonomy. It should report safe, top-coded usage buckets from this existing interaction system.

Current feature-education and exposure surfaces are not uniform:

- Feature wall / Explore Orca already has `feature_wall_*` telemetry.
- Onboarding feature setup already has `onboarding_feature_setup_*` telemetry.
- Setup-script prompt already has `setup_script_prompt_shown` and `setup_script_prompt_action`.
- Orca CLI feature tip already has `orca_cli_feature_tip_*`.
- `FeatureTipsModal` currently has two tips: `orca-cli` and `voice-dictation`; tips are marked seen when opened, and the modal has real user actions, but this is not how every feature is shown.

Therefore this plan does not propose a universal `feature_exposure_dismissed` event. Dismissal is only meaningful for specific surfaces that already expose skip/dismiss actions, such as setup-script prompts or feature-tip modals.

## Standard Pattern

The standard pattern for product analytics in desktop/devtool-style products is:

- Track explicit user actions and workflow outcomes, not every micro-interaction.
- Use typed schemas and closed enums for event names and properties.
- Keep product telemetry separate from debug logging, observability metrics, traces, and local UI state.
- For feature-frequency questions, report coarse usage buckets or histograms, not exact counts and not every occurrence.
- Top-code the highest bucket so power users remain represented without creating an infinite ladder of `count_200`, `count_500`, `count_1000`, `count_2000`, and so on.
- Treat first-use and repeat-use as product signals, but treat high-frequency action streams as local state unless a specific bucket boundary answers a product decision.

That means the plan should not keep adding arbitrary exact thresholds whenever we notice a higher count. It should use a bounded usage-depth scale that can represent `>200` and `>1000` while still guaranteeing low volume.

## Product Questions And Decisions

| Question | Product decision supported | Owner/use |
| --- | --- | --- |
| Which features do retained users actually use early? | Promote, simplify, or teach features that correlate with D3/D7 return. | Product analytics ranks feature-use buckets by retention association. |
| Which features are used once versus repeatedly? | Distinguish shallow discovery from real adoption. | Product compares first-use, repeat-use, and heavy-use buckets. |
| Which current onboarding/setup surfaces lead to real feature use? | Keep or rewrite surfaces based on downstream usage, not passive visibility. | Product joins existing exposure/setup events to later feature-use buckets. |
| Which unexpected features correlate with retention? | Find new candidates for onboarding, feature tips, defaults, or product polish. | Product looks beyond the known top retention signals. |
| Are users reaching repeat-workspace/manual-agent/setup-script/settings behaviors? | Move onboarding toward concrete work and away from passive tours. | Product compares early feature-use buckets with activation-depth buckets. |
| Do users do real task-provider work after opening Tasks? | Distinguish generic Tasks discovery from GitHub, GitLab, or Linear work-item adoption. | Product decides which provider flows deserve onboarding/setup emphasis. |
| Do users use Cmd+J as a navigation/action launcher? | Decide whether Cmd+J deserves more onboarding, shortcut education, or result-surface polish. | Product compares opening the palette with selecting workspace, settings, browser-tab, and quick-action destinations. |
| Do users create browser tabs or markdown files as workbench artifacts? | Decide whether early workspace education should emphasize browser-backed work, markdown notes, or terminal-only flow. | Product compares new browser tab and new markdown file usage buckets with retention and repeated workspace behavior. |
| Do browser annotations turn into agent follow-up work? | Distinguish collecting browser feedback from actually sending that feedback to an agent. | Product decides whether browser annotation education should emphasize "send to agent" as the key outcome. |
| Do users adopt or reject the floating workspace? | Decide whether floating workspace should stay prominent by default or need different placement/education. | Product compares `floating-workspace` usage with explicit `floating-workspace-hidden` actions. |

Non-goals:

- Do not track every click, hover, render, tab switch, keystroke, command, prompt, path, URL, repo, branch, hostname, raw error, or user text.
- Do not send timers, heartbeats, recurring session summaries, or passive state snapshots.
- Do not upload raw local feature-interaction records or exact local timestamps.
- Do not assume every feature has the same exposure or dismissal surface.
- Do not add source-control action usage buckets in this pass. Commit/stage/sync/status/check flows can be high-frequency, and the retention decision is weaker than for onboarding, task, setup, workspace, and agent-depth behavior.
- Do not add file-explorer or workspace-search usage buckets in this pass. They may indicate workbench usage, but they are broad utility actions and do not yet map to a clear onboarding or retention product decision.
- Do not add runtime-environment usage buckets in this pass. In Orca, runtime environments are saved/paired execution targets such as a remote Orca server; SSH already has a separate feature id, and remote/server usage needs a clearer product question before it belongs in this catalog.
- Do not track Cmd+J query text, selected workspace names, selected settings labels, file paths, URLs, or per-keystroke search behavior. Track only palette-open and coarse destination/action categories.
- Do not treat minimizing/closing the floating workspace panel as hiding/rejecting it. Only an explicit disable/hide action should record `floating-workspace-hidden`.

## How This Helps Retention

The existing retention read says concrete, intentional work retains better than passive setup:

| Known signal | Retention read | Product action |
| --- | --- | --- |
| 2+ new workspaces in 72h | 68.4% retained. Strongest repeat-workspace signal. | Teach users to start parallel workspaces. |
| Manual/followup agent action | 56.0% retained. Stronger than automatic onboarding agent start. | Teach continuation and manual agent launch for ADE-style users. |
| Post-repo setup action | 56.5% D3 / 68.9% D7. Concrete work after repo add. | Show useful features immediately after setup. |
| Agent started + later manually/again | 54.0% D3. Strong activation-depth bucket; likely existing ADE users. | Explain and generate useful next agent actions. |
| Open existing workspace first | 58.5% D3 / 69.3% D7. High-intent users retain well. | Encourage existing-workspace users into parallel workspace behavior. |
| Settings changed | 50.9% D3 / 67.6% D7. Strong high-intent signal. | Help users make Orca fit their workflow. |
| Feature setup terminal interaction | 45.5% D3. Interaction beats broad exposure. | Prefer guided setup actions over passive explanation. |
| 3+ meaningful action types | 57.9% retained. Multiple real actions across product areas. | Replace passive tour content with interactive onboarding. |

The new telemetry should answer a broader question: which feature interactions, including unexpected ones, correlate with retention?

The useful unit is not "saw a thing on screen." The useful unit is "reached a feature-use bucket." For example:

- First `workspace-board-actions` bucket versus repeated kanban board action buckets.
- First `agent-browser-use` runtime use versus repeated Browser Use.
- First `voice-dictation` use via the dictation shortcut, such as Cmd+E on the default keymap, versus repeated dictation sessions.
- First `terminal-panes` or `terminal-tabs` bucket versus repeated workspace organization behavior.
- First GitHub/GitLab/Linear task-workflow bucket versus merely opening the Tasks page.
- First Cmd+J destination bucket: workspace jump, browser-page jump, settings jump, quick action, or create-workspace flow.
- First new browser-tab creation versus first new markdown-file creation.
- First browser annotation sent to an agent versus merely adding/copying/clearing annotations.
- First `floating-workspace` bucket versus explicit `floating-workspace-hidden`.
- First `setup_scripts` action from existing setup-script telemetry versus later retained usage.

This lets us compare:

- users who never use a feature,
- users who use it once,
- users who use it repeatedly,
- users who reach multiple feature categories early,
- and each group's D3/D7 return rate.

## Existing Events To Reuse

Do not duplicate these with new generic events:

- `app_opened`: D1+/D3+/D7+ return marker.
- `onboarding_started { cohort: 'fresh_install' }`: fresh-install cohort anchor.
- `repo_added`, `workspace_created`, `add_repo_setup_step_action`: repo/workspace/setup activation.
- `agent_started`, `agent_prompt_sent`: agent activation and manual/followup behavior through `request_kind`.
- `settings_changed`: whitelisted settings depth.
- `feature_wall_*`: Explore Orca exposure and tour behavior.
- `onboarding_feature_setup_*`: Browser Use, Computer Use, and Orchestration onboarding setup behavior.
- `setup_script_prompt_shown` / `setup_script_prompt_action`: setup-script prompt exposure and action.
- `orca_cli_feature_tip_*`: existing Orca CLI tip exposure/setup/result.

## Proposed New Event

### `feature_interaction_usage_bucket_reached`

Purpose: track how often users use each feature, without emitting every interaction.

Emit when `recordFeatureInteraction(id)` moves that feature's `interactionCount` into a higher top-coded usage bucket.

Proposed usage buckets:

- `count_1`: first meaningful interaction with the feature.
- `count_2`: first repeat interaction.
- `count_3_4`: early repeated use.
- `count_5_9`: meaningful repeat use.
- `count_10_19`: strong adoption.
- `count_20_49`: heavy use.
- `count_50_99`: habit-level use.
- `count_100_199`: power-user use.
- `count_200_499`: deep power-user use.
- `count_500_999`: very deep power-user use.
- `count_1000_plus`: top-coded power-user use.

Why use top-coded ranges:

- Some features are naturally high-frequency, especially launchers, terminal/workspace organization, browser annotations, task workflows, and workspace-board actions.
- Stopping at `count_20` or `count_200` would collapse steady power users into one undifferentiated group.
- Exact thresholds create the wrong pressure: every time someone asks about `>200`, we add `500`, then `1000`, then `2000`.
- Ranged, top-coded buckets answer the product question: did the user only try the feature, adopt it, make it a habit, or make it core workflow?
- `count_1000_plus` is intentionally the final bucket. After a user reaches it for a feature, more usage stays local unless a new product question justifies a new schema.

Payload:

- `feature_id`: closed enum derived from `FeatureInteractionId`.
- `feature_category`: closed enum for dashboard grouping.
- `count_bucket`: one of the top-coded buckets above.
- `bucket_source`: `crossed_now` or `observed_existing`.
- `nth_repo_added`: repo-count cohort from `getCohortAtEmit()` because this event should emit from main, not renderer IPC.

`bucket_source` is required so rollout data does not lie:

- `crossed_now`: the current interaction moved the feature from a lower bucket into this bucket.
- `observed_existing`: the user's local count was already inside this bucket before the telemetry marker existed, and this is the first real post-rollout interaction that let us observe it.

Do not include:

- exact interaction count,
- raw timestamps,
- source file/component name,
- prompts,
- commands,
- file paths,
- repo names,
- branch names,
- URLs,
- hostnames,
- raw errors,
- user text,
- workspace ids,
- persistent feature-specific ids.

### Feature Id Enum

Use the existing catalog, normalized only if needed for telemetry naming, with the following task-provider depth additions made before implementation:

- Add `github-tasks`, `gitlab-tasks`, and `linear-tasks` to `FeatureInteractionId`.
- Record provider depth only for meaningful task workflows: opening an item detail, starting a workspace from an item, editing/commenting on a provider item, or another explicit provider item action.
- Do not record provider depth for provider visibility, provider tab switches, filter/query edits, background refreshes, or list pagination.
- Keep the existing `tasks` id as the surface-level "Tasks page opened" bucket.

- `workspace-board`
- `workspace-board-actions`
- `cmd-j`
- `cmd-j-workspace-open`
- `cmd-j-browser-page-open`
- `cmd-j-settings-open`
- `cmd-j-quick-action`
- `cmd-j-create-workspace`
- `browser`
- `browser-tab-created`
- `tasks`
- `github-tasks`
- `gitlab-tasks`
- `linear-tasks`
- `automations`
- `automation-created`
- `automation-run`
- `browser-annotations`
- `browser-annotations-sent-to-agent`
- `browser-grab`
- `workspace-creation`
- `agent-browser-setup`
- `agent-browser-use`
- `agent-orchestration-setup`
- `agent-orchestration`
- `ai-commit-generation`
- `ai-pr-generation`
- `claude-account-switching`
- `computer-use-setup`
- `computer-use`
- `codex-account-switching`
- `cookie-import`
- `floating-workspace`
- `floating-workspace-hidden`
- `mobile-pairing`
- `notifications`
- `ports`
- `quick-commands`
- `resource-manager`
- `review-notes`
- `ssh`
- `terminal-panes`
- `terminal-tabs`
- `tab-splits`
- `markdown-file-created`
- `usage-tracking`
- `voice-dictation`
- `workspace-cleanup`

### Feature Category Enum

Use a static map from `FeatureInteractionId` to a low-cardinality category:

- `workspace`
- `agent`
- `browser`
- `launcher`
- `task_management`
- `notes`
- `review`
- `setup`
- `settings`
- `automation`
- `terminal`
- `collaboration`
- `resource_management`
- `voice`
- `source_control`

The category exists for dashboards only. It should be derived from the feature id at emit time, not supplied by arbitrary call sites.

## When Data Is Reported

Report only when a real, existing feature-use writer increments the local interaction count and moves into a higher telemetry bucket.

Examples:

- User opens Tasks for the first time -> local `tasks` count becomes 1 -> emit `feature_interaction_usage_bucket_reached { feature_id: 'tasks', count_bucket: 'count_1', bucket_source: 'crossed_now' }`.
- User opens Cmd+J -> local `cmd-j` count becomes 1 -> emit `count_1`.
- User selects a workspace, browser page, settings result, quick action, or create-workspace row from Cmd+J -> emit the matching `cmd-j-*` usage bucket.
- User creates a new browser tab -> local `browser-tab-created` count becomes 1 -> emit `count_1`.
- User creates a new untitled markdown file -> local `markdown-file-created` count becomes 1 -> emit `count_1`.
- User sends browser annotations to a new agent from the browser annotation menu -> local `browser-annotations-sent-to-agent` count becomes 1 -> emit `count_1`.
- User opens, enables, or configures Floating Workspace -> local `floating-workspace` count becomes 1 -> emit `count_1`.
- User explicitly hides/disables Floating Workspace from settings or the floating-workspace menu -> local `floating-workspace-hidden` count becomes 1 -> emit `count_1`.
- User opens a GitHub issue/PR detail, starts a workspace from a GitHub item, or acts on a GitHub task item -> local `github-tasks` count becomes 1 -> emit `count_1`.
- User opens a GitLab issue/MR detail, starts a workspace from a GitLab item, or acts on a GitLab task item -> local `gitlab-tasks` count becomes 1 -> emit `count_1`.
- User opens, edits, comments on, or starts work from a Linear issue -> local `linear-tasks` count becomes 1 -> emit `count_1`.
- User starts dictation for the fifth time -> local `voice-dictation` count becomes 5 -> emit `count_5_9`.
- User uses Browser Use through runtime RPC for the second time -> local `agent-browser-use` count becomes 2 -> emit `count_2`.
- User uses workspace board actions repeatedly -> emit only when entering a higher bucket such as `count_3_4`, `count_5_9`, `count_10_19`, or `count_20_49`, not for every drag/drop/status change.

Do not report:

- every call to `recordFeatureInteraction`,
- component renders,
- hover/focus,
- a feature merely being visible,
- Cmd+J query edits, result ranking changes, highlighted result changes, selected workspace names, settings labels, file paths, URLs, or per-keystroke search behavior,
- browser annotation prompt text, selected page URL/title, DOM snippets, screenshots, comments, or generated agent prompt content,
- dictation audio, transcripts, partial transcripts, inserted text, hotwords, model ids, microphone device names, or failed permission/error details,
- floating workspace minimize/close actions, panel focus changes, drag/move events, directory paths, or trusted-directory values,
- task filter changes, query edits, provider tab switches, or refreshes,
- source-control status changes, staging churn, background check polling, file-tree navigation, or search typing,
- "still using Orca" summaries,
- app-open snapshots of all feature counts,
- local feature-interaction state dumps.

If a user sees many features and keeps using Orca without using a new feature:

- `app_opened` still records D3/D7 return.
- Existing product events still record meaningful work, such as agent, workspace, setup, settings, and setup-script actions.
- This new feature event emits only if their ongoing use crosses a new bucket for a feature.
- If they do not cross a new feature-use bucket, we intentionally send no generic feature telemetry.

This is how we get "how often they use each feature" without creating a high-volume stream: counts stay local, and telemetry receives only bucket crossings.

### Rollout And Existing Count Handling

Users may already have local `interactionCount` values above a bucket boundary before this telemetry ships. If implementation only emits when `newCount === boundary`, we would miss those users until they happen to enter a future bucket. That would undercount high-use features and bias retention analysis.

Implementation should persist a small local telemetry-emission marker per feature, separate from the interaction count:

- Store the highest emitted usage bucket for each `FeatureInteractionId`.
- On every real `recordFeatureInteraction(id)` increment, compute the top-coded bucket containing `newCount`.
- If that bucket is higher than the last emitted bucket for that feature, emit exactly one event for the current bucket and update the marker.
- For a normal forward-looking user, count 99 -> 100 emits `count_100_199` with `bucket_source: 'crossed_now'`.
- For a pre-rollout user with `terminal-tabs` count 137, their next real `terminal-tabs` interaction should emit `count_100_199` once with `bucket_source: 'observed_existing'`, not `count_1` through `count_100_199`, and not repeatedly on every later interaction.
- When they later enter the 200-499 range, emit `count_200_499` once with `bucket_source: 'crossed_now'`.
- For a pre-rollout user already above 1,000 uses, emit `count_1000_plus` once with `bucket_source: 'observed_existing'`; there is no later bucket unless product explicitly approves a new top-code.

This preserves low volume while preventing existing high-usage users from disappearing from high-bucket analysis.

## Where To Emit

Preferred implementation point: centralize emission inside `Store.recordFeatureInteraction(id)` in `src/main/persistence.ts`, after the new `interactionCount` is computed.

Reason:

- Renderer, main-process persistence, runtime RPC, and remote/client UI paths already converge on `recordFeatureInteraction(...)`.
- Emitting at individual UI call sites would miss runtime RPC usage and would create duplicate/ inconsistent behavior.
- Emitting centrally lets tests prove bucket boundaries once.

Implementation note:

- The renderer currently increments local state optimistically in `src/renderer/src/store/slices/ui.ts` and then calls `window.api.ui.recordFeatureInteraction(id)`.
- Telemetry should be emitted from the persisted/main path only, not from both renderer and main.
- Runtime RPC already maps successful methods to local feature ids in `src/main/runtime/rpc/dispatcher.ts`; those should naturally flow through the same central emitter.
- Because this is a main-originated event, the call site must include `...getCohortAtEmit()` explicitly. The renderer `telemetry:track` IPC handler only injects `nth_repo_added` for renderer-originated telemetry.

## Exposure And Dismissal

Do not create a universal exposure/dismissal event family.

Use existing exposure/action telemetry where it exists:

- Feature wall: `feature_wall_*`
- Onboarding feature setup: `onboarding_feature_setup_*`
- Setup-script prompt: `setup_script_prompt_*`
- Orca CLI feature tip: `orca_cli_feature_tip_*`

For `FeatureTipsModal`, the code currently has two tips:

- `orca-cli`
- `voice-dictation`

The modal marks a tip seen when it opens. Voice has a "Maybe Later" action and a close affordance through the dialog. Orca CLI has existing dedicated telemetry for shown/clicked/result. If product wants voice-tip exposure/action telemetry too, add a small feature-tip-specific event, not a universal dismiss event. Dismissal should only be tracked for a surface with a real explicit skip/close action and only if that dashboard is worth building.

## Retention Correlation Analysis

Primary analysis windows:

- First 24 hours after `onboarding_started { cohort: 'fresh_install' }`.
- First 72 hours after `onboarding_started { cohort: 'fresh_install' }`.
- First 72 hours after first `repo_added`.

Retention outcomes:

- D3 return: at least one `app_opened` after 72 hours from cohort start.
- D7 return: at least one `app_opened` after 168 hours from cohort start.
- Meaningful return: D3/D7 return plus at least one later meaningful action, where query maturity allows it.

Correlation matrix:

| Dimension | Values | Product use |
| --- | --- | --- |
| Feature | `FeatureInteractionId` enum | Rank feature-use buckets by D3/D7 return. |
| Usage depth | `count_1`, `count_2`, `count_3_4`, `count_5_9`, `count_10_19`, `count_20_49`, `count_50_99`, `count_100_199`, `count_200_499`, `count_500_999`, `count_1000_plus` | Distinguish first touch, adoption, habit-level use, and power-user use without exact counts. |
| Category | workspace, agent, browser, review, setup, settings, automation, terminal, etc. | Find product areas that correlate with retention. |
| Segment | fresh install, first repo, repeat workspace, open-existing setup, existing workspace detected | Avoid overfitting onboarding to already-activated users. |
| Existing exposure path | feature wall, onboarding setup, setup-script prompt, feature tip, none observed | Learn whether education surfaces lead to actual use. |
| Outcome | D3, D7, meaningful return | Choose what to promote or simplify. |

Interpretation:

- First-use high retention: feature may be a strong activation signal and should be easier to discover.
- Repeat-use high retention: feature may represent real habit formation and should be taught earlier.
- Exposure high but usage low: surface is not moving behavior.
- Usage high but retention low: feature may be useful but not retention-driving, or it may be used by struggling users.
- No exposure observed but usage high/retention high: users find the feature organically; consider targeted education.
- High dismissal of an existing dismissible surface but later organic usage: timing may be wrong.

## Dashboard Tiles Expected

1. Feature usage buckets by D3/D7 retention

- Metric: users reaching each `feature_id` + `count_bucket` in first 24h/72h, joined to D3/D7 `app_opened`.
- Decision: choose which features to promote in onboarding and tips.

2. Repeat-use depth by feature

- Metric: `count_1` -> `count_2` -> `count_3_4` -> `count_5_9` -> `count_10_19` -> `count_20_49` -> `count_50_99` -> `count_100_199` -> `count_200_499` -> `count_500_999` -> `count_1000_plus` by feature.
- Decision: distinguish novelty from actual adoption.

3. Feature category retention matrix

- Metric: D3/D7 return by `feature_category` and highest bucket reached.
- Decision: choose whether onboarding should emphasize workspace, agent, task management, browser, review, setup, settings, or terminal behaviors.

4. Existing education surface to usage

- Metric: existing feature-wall/onboarding/setup-tip exposure or action -> later `feature_interaction_usage_bucket_reached`.
- Decision: keep only education surfaces that create downstream usage.

5. Known retention signal conversion

- Metric: early feature-use buckets -> known high-retention behaviors: 2+ workspaces, manual/followup agent action, post-repo setup action, open-existing first setup action, settings changed, setup terminal interaction, or 3+ meaningful action types.
- Decision: move users toward proven activation-depth behaviors.

6. Unexpected feature correlation watchlist

- Metric: features with enough sample size whose count buckets show above-baseline D3/D7 return.
- Decision: create hypotheses for new onboarding steps, tips, defaults, or simplifications.

7. Task-provider depth retention

- Metric: users reaching `github-tasks`, `gitlab-tasks`, or `linear-tasks` usage buckets in the first 24h/72h, compared with users who only reach `tasks`.
- Decision: decide which task providers deserve onboarding emphasis, default shortcuts, or setup guidance, and whether provider-specific work-item flows correlate with retained users better than generic Tasks-page discovery.

8. Cmd+J destination depth

- Metric: users reaching `cmd-j` and each `cmd-j-*` destination bucket in the first 24h/72h.
- Decision: decide whether Cmd+J should be taught as a core navigation/action surface, and which destination classes prove useful: workspace jump, browser-page jump, settings jump, quick action, or create-workspace flow.

9. Workbench artifact creation

- Metric: users reaching `browser-tab-created` versus `markdown-file-created`, and the overlap with repeat workspace, agent, and task-provider usage buckets.
- Decision: decide whether early workspace education should emphasize browser-backed testing, markdown note-taking/review, or terminal/agent-first workflows.

10. Browser annotation agent handoff

- Metric: users reaching `browser-annotations-sent-to-agent`, compared with users who only reach `browser-annotations`.
- Decision: decide whether browser annotation education should push users toward sending focused UI feedback to an agent, not just collecting/copying annotations.

11. Kanban board and floating workspace adoption

- Metric: users reaching `workspace-board`, `workspace-board-actions`, `floating-workspace`, and `floating-workspace-hidden`.
- Decision: decide whether to teach kanban board actions earlier, keep Floating Workspace prominent by default, or adjust floating-workspace placement if hide/disable behavior is high.

## Volume Estimate At 2,000 DAU

This design is bucketed by feature and top-coded usage depth, not per interaction.

Hard cap:

- Each feature can emit at most 11 usage-bucket events per user lifetime under this schema.
- A user who uses a feature 1,000 times and a user who uses it 10,000 times both stop at `count_1000_plus`.
- The exact local count remains local.

Expected:

- Average feature usage-bucket events/user/day: 2.0 to 3.0
- At 2,000 DAU: 4,000 to 6,000 events/day
- Monthly: 120,000 to 180,000 events/month

Modeled high activity:

- 5 feature usage-bucket events/user/day during normal operation
- At 2,000 DAU: 10,000 events/day

Rollout spike risk:

- Existing users with high local interaction counts may emit one observed-existing bucket on their next real interaction for a feature.
- This is acceptable only if implementation emits one current bucket per feature, not every missed lower bucket.
- If pre-release QA estimates a large one-time spike, stage the event behind a rollout flag or limit Phase 1 to the highest-priority feature ids.

Gate:

- Expected volume passes.
- The high-activity model is at the gate, so implementation must not emit every interaction. Task-provider depth must stay tied to explicit item workflows, not list browsing, filters, provider switches, refreshes, or pagination.
- Cmd+J telemetry must emit only on open and selection, not on query changes, result ranking, keyboard navigation, or focus changes.
- Browser-tab and markdown-file telemetry must emit only on explicit creation actions, not on restoring persisted tabs, opening existing markdown files, preview tabs, session hydration, or remote/web mirror reconciliation.
- Browser annotation handoff telemetry must emit only when the user explicitly sends browser annotations to an agent. Do not include annotation text, prompt text, DOM snippets, screenshots, page URL/title, or selected agent details.
- Floating workspace hide telemetry must emit only from explicit disable/hide actions, not from minimizing, closing, dragging, focusing, or moving the trigger between status bar and floating button.
- If real production volume exceeds the modeled rate, reduce bucket count, stage the catalog, or sample before adding more feature ids.

## Privacy Review

Allowed:

- Low-cardinality feature ids from the product-owned `FeatureInteractionId` catalog.
- Low-cardinality feature categories.
- Coarse top-coded count buckets, up to `count_1000_plus`.
- Existing `nth_repo_added` from `getCohortAtEmit()`.

Forbidden:

- exact interaction counts,
- raw local state dumps,
- prompts,
- commands,
- file paths,
- repo names,
- branch names,
- URLs,
- hostnames,
- raw errors,
- stack traces,
- tokens,
- user text,
- persistent workspace/repo/feature-instance identifiers.

SSH/remote consideration:

- Runtime RPC feature interactions already pass through main/runtime code and local UI persistence where available.
- Do not add hostnames, remote paths, or target ids to feature telemetry.
- Dashboard interpretation must account for existing telemetry caveats: remote/web paths can bypass native repo/worktree telemetry, so missing workspace outcome rows are not proof of drop-off.

## Tests Required Before Implementation

Schema tests:

- Accept valid `feature_interaction_usage_bucket_reached` payloads.
- Reject unknown `feature_id`.
- Reject unknown `feature_category`.
- Reject unknown `count_bucket`.
- Reject unknown `bucket_source`.
- Reject extra fields via `.strict()`, including `prompt`, `command`, `path`, `repo`, `branch`, `url`, `hostname`, `error`, and `text`.
- Verify feature id enum stays in sync with `FEATURE_INTERACTION_IDS`.
- Verify feature category map covers every `FeatureInteractionId`.
- Verify count-bucket enum includes `count_1`, `count_2`, `count_3_4`, `count_5_9`, `count_10_19`, `count_20_49`, `count_50_99`, `count_100_199`, `count_200_499`, `count_500_999`, and `count_1000_plus`.
- Verify Cmd+J schemas reject raw query text, result labels, selected workspace names, selected setting names, file paths, URLs, and target ids.
- Verify browser annotation handoff rejects annotation text, prompt text, DOM snippets, screenshots, page URL/title, and selected agent details.
- Verify floating workspace hide rejects directory paths, trusted-directory values, trigger coordinates, and focus/minimize state.

Emission tests:

- Crossing count 1 emits `count_1`.
- Crossing 2 emits `count_2`.
- Crossing 3 emits `count_3_4`; incrementing from 3 to 4 emits no event.
- Crossing 5 emits `count_5_9`; incrementing from 5 to 6 emits no event.
- Crossing 10, 20, 50, 100, 200, 500, and 1000 emits exactly one event for the corresponding top-coded bucket.
- Incrementing from 99 to 100 emits `count_100_199`; incrementing from 100 to 101 emits no event.
- Incrementing from 199 to 200 emits `count_200_499`; incrementing from 201 to 202 emits no event.
- Incrementing from 999 to 1000 emits `count_1000_plus`; incrementing from 1000 to 1001 emits no event.
- Incrementing a pre-rollout feature from 137 to 138 with no prior emitted marker emits `count_100_199` once with `bucket_source: 'observed_existing'`.
- Incrementing a pre-rollout feature from 1200 to 1201 with no prior emitted marker emits `count_1000_plus` once with `bucket_source: 'observed_existing'`, not every lower bucket.
- A feature with `count_100_199` already marked emitted does not emit that bucket again on later increments.
- Forward-looking bucket crossings emit `bucket_source: 'crossed_now'`.
- Rehydrating or normalizing local state emits no event.
- Renderer optimistic update does not emit; persisted/main `recordFeatureInteraction` emits once.
- Runtime RPC interactions still emit through the central path.
- GitHub/GitLab/Linear task-provider writers emit only for meaningful item workflows and not for filters, provider switches, refreshes, or pagination.
- Cmd+J opening and each destination class increment only one matching feature id, with no emissions for typing, keyboard navigation, result reranking, hover, or focus.
- New browser-tab and markdown-file creation emit only for explicit user-created tabs/files, not hydration/restoration/mirroring/open-existing flows.
- Browser annotation send-to-agent increments `browser-annotations-sent-to-agent` once per explicit send action and still relies on existing agent telemetry for the downstream agent start/prompt outcome.
- Kanban board opening continues to increment `workspace-board`; kanban card/status/lane/density/drag/pin/drop actions continue to increment `workspace-board-actions`.
- Floating workspace hide/disable increments `floating-workspace-hidden`; minimizing or closing the panel does not.
- Invalid feature ids are rejected before telemetry.

Validation commands for the implementation PR:

```bash
pnpm test src/shared/feature-interactions.test.ts
pnpm test src/shared/telemetry-events.test.ts
pnpm test src/main/persistence.test.ts
pnpm test src/main/runtime/rpc/dispatcher-feature-interactions.test.ts
pnpm typecheck
pnpm lint
```

## Implementation Approval Checklist

- Event answers the product question: which features and repeat-use depths correlate with retention?
- Emission is centralized on existing meaningful feature-use writers.
- No passive exposure, render-loop, hover, timer, heartbeat, or session-summary telemetry is added.
- Every payload field is low-cardinality and schema-validated.
- Expected 2,000 DAU volume remains under 10,000 events/day.
- Existing exposure/action events are reused for education surfaces.
- Tests prove bucketed emission, schema rejection, and no duplicate renderer/main telemetry.
