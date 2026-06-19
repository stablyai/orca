# Feature Education Retention Analytics

This document records how Orca should use contextual-tour telemetry to evaluate retention and feature adoption.

## Decision

Track only contextual tour exposure and outcome in PostHog:

- `contextual_tour_shown`
- `contextual_tour_outcome`

Do not add broad telemetry that mirrors local education state, such as "feature interaction first recorded." Local state like `featureInteractions` exists to suppress redundant education on the user's machine; it is not the analytics source of truth.

Feature adoption analysis should join tour cohorts to existing downstream product events. Add new telemetry only for concrete user actions that are not already represented by an existing event.

Automatic contextual tours are limited to new users for this rollout. The local `contextualToursAutoEligible` flag is set once after persisted UI and onboarding state load: users still in first-run onboarding become eligible; users with closed onboarding become ineligible. This avoids surprising existing users with education for surfaces they may already understand.

## Product Questions

Use the data to answer:

- Do users who see contextual tours retain better at D1 and D7?
- Do completed tours correlate with higher downstream feature adoption than skipped or cancelled tours?
- Which tours have high skip/cancel rates and should be revised or suppressed?
- Which tours introduce features that users later use in real workflows?

## Event Contract

### `contextual_tour_shown`

Emitted once when a contextual tour first renders a measured target.

Payload:

- `tour_id`: `workspace-board`, `workspace-agent-sessions`, `browser`, `tasks`, `automations`, or `workspace-creation`
- `source`: bounded source enum from `src/shared/feature-education-telemetry.ts`
- `was_feature_previously_interacted`: boolean from local education state at the moment the tour is shown

### `contextual_tour_outcome`

Emitted once when a contextual tour ends.

Payload:

- `tour_id`: same enum as `contextual_tour_shown`
- `source`: same bounded source enum
- `outcome`: `completed`, `skipped`, or `cancelled`
- `steps_seen`: bounded integer
- `total_steps`: bounded integer

## Dashboard Plan

Create a PostHog dashboard named **Feature Education Retention**.

### Tile: Tour Exposure Volume

Question: How often are tours shown?

Insight:

- Event: `contextual_tour_shown`
- Breakdown: `tour_id`
- Visualization: stacked time series by day

Action:

- If volume is unexpectedly high, inspect gating before expanding tours.
- If a tour is never shown, verify the surface gate and target selectors.

### Tile: Tour Outcome Rate

Question: Which tours are completed, skipped, or cancelled?

Insight:

- Event: `contextual_tour_outcome`
- Breakdown: `tour_id` and `outcome`
- Visualization: stacked bar or table

Action:

- High skipped rate means copy, timing, or audience targeting needs revision.
- High cancelled rate means UI state is likely interrupting tours or targets are disappearing.

### Tile: Median Steps Seen

Question: How far do users get before leaving?

Insight:

- Event: `contextual_tour_outcome`
- Metric: median `steps_seen`
- Breakdown: `tour_id`
- Optional derived ratio: `steps_seen / total_steps`

Action:

- If most users see only step 1, shorten or reprioritize the tour.
- If later steps are rarely reached, do not rely on those steps for critical education.

### Tile: D1/D7 Retention By Tour Outcome

Question: Does tour status correlate with retention?

Insight:

- Cohort A: users with `contextual_tour_outcome` where `outcome = completed`
- Cohort B: users with `contextual_tour_outcome` where `outcome = skipped`
- Cohort C: users with `contextual_tour_outcome` where `outcome = cancelled`
- Cohort D: users with no `contextual_tour_shown`
- Retention: return to `app_opened` on day 1 and day 7
- Breakdown: `tour_id` where PostHog supports it, otherwise build one insight per tour

Action:

- Keep or expand tours whose completed cohort outperforms skipped/no-tour cohorts.
- Rework or suppress tours whose shown cohort underperforms no-tour users.

### Tile: Downstream Feature Adoption By Tour

Question: Do users later use the feature taught by the tour?

Build funnels from tour events to real product events:

- `tasks`: `contextual_tour_outcome` -> workspace creation from task-linked flows where existing telemetry exposes the source; if the current event is insufficient, add a targeted task-started-workspace event.
- `workspace-creation`: `contextual_tour_outcome` -> `workspace_created`
- `browser`: `contextual_tour_outcome` -> browser grab/annotation events. If these do not exist, add targeted events for the concrete actions, not a broad feature-interaction event.
- `automations`: `contextual_tour_outcome` -> automation creation/run events. If these do not exist, add targeted events for create/run.
- `workspace-board`: `contextual_tour_outcome` -> board-specific actions such as card moved/status changed. If these do not exist, add targeted events for those actions.
- `workspace-agent-sessions`: `contextual_tour_outcome` -> terminal pane split actions and later workspace creation.

Recommended funnel shape:

1. `contextual_tour_shown` filtered by `tour_id`
2. `contextual_tour_outcome` filtered by same `tour_id`, broken down by `outcome`
3. Downstream action event within 1 day and 7 days

Action:

- If completion improves downstream action conversion, keep the tour.
- If shown-but-skipped users still convert, the surface may be discoverable without a tour.
- If no downstream event exists, add the smallest action-specific telemetry needed for that feature.

## Telemetry Cost Rule

At 1,000 DAU, this PR should emit at most:

- One `contextual_tour_shown` per shown tour
- One `contextual_tour_outcome` per shown tour
- Currently one contextual tour per session

Expected launch volume: under 2,000 events/day at 1,000 DAU and lower for mature cohorts because existing users are not auto-eligible and `contextualToursSeenIds` fills in for eligible new users.

Do not add recurring, render-loop, polling, passive snapshot, or local-state-mirror events for this analysis.

## Privacy Rule

Payloads must remain low-cardinality and bounded. Do not include:

- prompts
- commands
- paths
- URLs
- hostnames
- repo names
- branch names
- user-entered text
- raw errors
- tokens or IDs beyond the existing anonymous telemetry identity

## Existing Users

Existing users should not receive automatic contextual tours from this rollout. We cannot reliably know whether they have already viewed or used every covered surface, so the least surprising default is to leave them alone and measure this launch on new-user cohorts.

Implementation:

- `contextualToursAutoEligible: false` for profiles whose onboarding is already closed when the rollout first runs
- `contextualToursAutoEligible: true` for profiles still in first-run onboarding when the rollout first runs
- automatic tour requests require `contextualToursAutoEligible === true`
- local `featureInteractions` still records supported surface entry for all users after UI hydration

For existing-user analysis, compare users by actual tour exposure and outcome only when they have exposure. Most existing users should fall into the no-tour baseline for this PR. If a later release adds manual tour entry points or truly new feature education, evaluate that release separately instead of reusing this rollout's eligibility rule.
