# New User Parallel Work Telemetry

## Goal

Measure whether the new parallel-work tours and the eight-step `Getting started` flow improve new-user activation and retention.

The product question is not "did the tour render?" It is:

- Did users who were eligible for the new parallel-work education retain better at D1, D3, and D7?
- Did seeing or completing the tour increase the behaviors that the activation plan expects: terminal splits, two agents in one worktree, two worktrees within 72 hours, task/review source use, setup script configuration, notifications, and agent capability setup?
- Where do users leave the education flow: before the tour starts, during a tour, after skipping a tour, after opening `Getting started`, or partway through the eight setup steps?

This document implements the telemetry portion of [`new-user-parallel-work-activation.md`](./new-user-parallel-work-activation.md).

Validation mode: the current branch logs the would-be event name and payload to the console instead of sending these new feature-education events through product telemetry. Keep the logged payload shape identical to the event payloads below so reviewers can verify what would be emitted before product telemetry is re-enabled.

## Product Decisions

Question: Should Orca keep, revise, or disable the automatic `workspace-agent-sessions` tour for new users?

Decision owner/use: Product and growth review the retention and activation read after rollout. If exposed users retain and activate better than eligible-but-unexposed users, keep or expand the tour. If exposed users underperform or skip/cancel heavily, revise copy, timing, or gating.

Question: Which part of the education flow is weak?

Decision owner/use: If users usually stop on a specific tour step, revise that step or shorten the tour. If users complete the tour but do not progress through `Getting started`, improve the handoff. If users open `Getting started` but stall before the first two parallel-work steps, revise the checklist actions.

Dashboard: `New User Parallel Work Activation`

Action: Use the dashboard to decide whether to continue rollout, adjust the tour, reorder checklist steps, or add missing downstream action telemetry.

## Existing Telemetry To Reuse

Keep the existing contextual-tour events as the primary tour exposure and outcome contract:

- `contextual_tour_shown`
- `contextual_tour_outcome`

`contextual_tour_outcome` already carries:

- `tour_id`
- `source`
- `outcome`: `completed`, `skipped`, or `cancelled`
- `steps_seen`
- `total_steps`

For the current branch, `workspace-agent-sessions` is the activation tour. Its source should distinguish automatic first-workspace exposure from checklist-triggered education:

- `workspace_agent_sessions_visible` for automatic surface-driven tour exposure
- `setup_guide_parallel_work` for the explicit checklist `Try it out` path

Do not add one telemetry event per tour opportunity or step render. Opportunity checks are driven by local UI eligibility, retries, target visibility, modal state, and session guards; emitting every "not shown" reason would turn tour gating into passive eligibility telemetry. One shown event plus one outcome event keeps volume low and still answers whether users saw, skipped, cancelled, completed, and how far they got.

## Tour Depth Improvement

Add stable step-depth fields to `contextual_tour_outcome` so the analysis can tell whether a user reached the actual late steps, not only how many visible steps happened to render.

Additive schema fields:

- `furthest_step_index`: integer `1..8`
- `defined_step_count`: integer `1..8`

Keep `steps_seen` and `total_steps`:

- `steps_seen` remains the count of unique rendered visible steps.
- `total_steps` remains the visible-step denominator for the user session.
- `furthest_step_index` is the highest 1-based index from the tour definition reached by the user.
- `defined_step_count` is the number of steps defined for that tour, regardless of target skipping.

This handles target-skipping correctly. A user who sees tour steps 1, 4, and 5 should report `steps_seen: 3`, `total_steps: 3`, `furthest_step_index: 5`, and `defined_step_count: 5`.

## New Setup Guide Events

The eight `Getting started` steps need a small telemetry contract because they are not contextual-tour steps. They are durable activation milestones.

### `setup_guide_opened`

Emit once when the modal opens.

Payload:

- `source`: `sidebar`, `contextual_tour`, `settings`, `feature_wall`, `help_menu`, or `unknown`
- `initial_completed_count`: integer `0..8`
- `total_steps`: integer `8`
- `first_incomplete_step_id`: one of the eight setup step ids, or `none`

Use:

- Measures whether users reach the checklist after the tour.
- Establishes starting depth so existing progress does not look like checklist-driven progress.

### `setup_guide_closed`

Emit once when a shown setup guide closes or unmounts.

Payload:

- `source`: same value used by `setup_guide_opened`
- `outcome`: `completed`, `dismissed`, or `interrupted`
- `initial_completed_count`: integer `0..8`
- `final_completed_count`: integer `0..8`
- `total_steps`: integer `8`
- `active_step_id`: one of the eight setup step ids, or `none`

Use:

- Measures whether users treat the checklist as useful or dismiss it without progress.
- Gives a compact "how far through the 8 steps" read without uploading a progress snapshot on every render.

### `setup_guide_step_completed`

Emit once per setup step when that step first transitions from incomplete to complete while the setup guide is visible. Hidden/background progress is persisted locally as baseline state but not emitted, because async setup refresh cannot reliably distinguish old completions from new user action.

Payload:

- `step_id`: one of `split-terminal`, `two-worktrees`, `notifications`, `default-agent`, `task-sources`, `setup-script`, `add-two-repos`, `agent-capabilities`
- `section_id`: `parallel-work` or `setup`
- `completed_count`: integer `1..8`
- `total_steps`: integer `8`
- `setup_guide_visible`: boolean

Use:

- Measures the in-guide depth through the eight steps without backfilling old setup state on launch.
- Lets retention analysis bucket users by `0`, `1`, `2`, `3-4`, `5-7`, and `8` completed setup steps.

Implementation detail: persist a local set of emitted setup-guide step ids, similar in spirit to `contextualToursSeenIds`, so inferred durable state does not re-emit on every launch. Do not upload that local set.

## Downstream Activation Events

Reuse existing downstream events whenever possible:

- `workspace_created` for worktree/workspace creation depth
- `agent_started` for agent activity and follow-up actions
- `settings_changed` for supported settings such as notifications
- setup script prompt events for setup-script configuration paths
- task/source-specific events where they already exist

Add action-specific downstream telemetry only when the retention question cannot be answered from existing events. The first likely gap is terminal splitting. The activation plan names first-session terminal split as a primary success criterion, but the branch currently records `terminal-pane-split` as local feature-interaction state, not product telemetry.

If no existing telemetry captures terminal split, add:

### `terminal_pane_split`

Emit when a split succeeds, capped to the first split for each `source` + `direction` pair per UTC day on the local profile. This keeps the event useful for activation cohorts without making heavy terminal users dominate telemetry volume.

Payload:

- `source`: `contextual_tour`, `keyboard`, `context_menu`, `command`, `unknown`
- `direction`: `vertical` or `horizontal`

Do not include pane ids, worktree ids, paths, commands, prompts, repo names, branch names, hostnames, or terminal content.

## Retention Analysis

Use new-user eligibility as the least-biased baseline:

1. Eligible baseline: new-user cohorts represented by first-run/onboarding events rather than uploading local tour eligibility state.
2. Exposed cohort: users with `contextual_tour_shown` where `tour_id = workspace-agent-sessions`.
3. Tour outcome cohorts: users with `contextual_tour_outcome` broken down by `outcome`.
4. Tour depth cohorts: `furthest_step_index / defined_step_count` and `steps_seen / total_steps`.
5. Checklist depth cohorts: latest `setup_guide_step_completed.completed_count`, bucketed as `0`, `1`, `2`, `3-4`, `5-7`, and `8`.

Primary retention read:

- D1, D3, and D7 return to `app_opened`
- Compare new-user baseline, shown, completed, skipped, cancelled, and checklist-depth cohorts

Primary activation read:

- terminal split in first workspace session
- two agent sessions in one worktree
- two worktrees within 72 hours
- follow-up/manual agent action
- task/review source use
- setup script configured
- notifications configured
- agent capabilities completed

Interpretation rules:

- A completed tour with no downstream activation means the tour is educational but not converting.
- A skipped tour with strong downstream activation means the feature may be discoverable without the tour.
- A high cancelled rate usually points to target loss, modal conflicts, or timing problems.
- Strong checklist-depth retention with weak tour retention means the checklist is the value driver, not the automatic tour.

## Volume Estimate

Telemetry volume estimate:

- Trigger: contextual tour shown/outcome, setup guide open/close, setup step first completion, optional terminal split
- Expected events/user/day: 2-6 for new users who encounter the flow
- Max events/user/day: about 14 on a heavy first day: 2 tour events, 2 setup guide events, 8 setup step completions, 1-2 split events
- At 1,000 DAU: expected 2,000-6,000 events/day
- Monthly at 1,000 DAU: expected 60,000-180,000 events/month
- Approval note: The events answer the rollout decision directly and are bounded by explicit user actions or one-time durable setup completions. There are no timers, render-loop events, polling snapshots, or passive heartbeats.

If observed volume exceeds expectation, remove or sample `setup_guide_opened` / `setup_guide_closed` before removing completion events. Completion events are the durable activation-depth read.

## Privacy

All payloads must be low-cardinality and schema-bounded.

Never include:

- prompts
- terminal commands
- paths
- URLs
- hostnames
- repo names
- branch names
- task titles
- user-authored text
- raw errors
- tokens
- pane ids, worktree ids, repo ids, or other persistent product identifiers

## Implementation Plan

1. Extend `contextual_tour_outcome` schema in `src/shared/telemetry-events.ts` with optional `furthest_step_index` and `defined_step_count`.
2. Track the highest reached defined tour step in `ContextualTourOverlay.tsx` alongside the existing `steps_seen` set.
3. Add setup-guide event schemas and bounded enums in `src/shared/telemetry-events.ts`.
4. Add a setup-guide telemetry helper in `src/renderer/src/lib/feature-education-telemetry.ts` or a dedicated setup-guide telemetry module.
5. Emit `setup_guide_opened` and `setup_guide_closed` from `SetupGuideModal.tsx`.
6. Emit `setup_guide_step_completed` from a small hook that observes visible setup-guide progress transitions, persists emitted step ids locally, and ignores hidden/background completions except as local baseline state.
7. Add `terminal_pane_split` only if no existing telemetry captures successful terminal splits.
8. Add schema tests for accepted payloads, rejected raw strings, count bounds, and enum bounds.
9. Add renderer tests that prove each modal open emits one open event, each close emits one close event, each step completion emits once, rerenders do not re-emit, and pre-completed persisted steps are not backfilled repeatedly.

## Dashboard Tiles

Create a PostHog dashboard named `New User Parallel Work Activation`.

Tiles:

- Tour exposure: `contextual_tour_shown` by `tour_id` and `source`
- Tour outcome: `contextual_tour_outcome` by `outcome`
- Tour depth: median `furthest_step_index / defined_step_count`
- Setup guide reach: `setup_guide_opened` by `source`
- Setup guide close outcome: `setup_guide_closed` by `outcome`
- Eight-step depth: latest `setup_guide_step_completed.completed_count` bucket
- Activation funnel: tour shown -> tour outcome -> setup guide opened -> first two setup steps complete -> D1/D3/D7 return
- Downstream actions: tour shown -> terminal split -> two agents in one worktree -> two worktrees within 72 hours

Do not publish dashboard tiles that require raw user content or identifiers.
