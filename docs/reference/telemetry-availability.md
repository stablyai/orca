# Telemetry Availability

Append-only reference for dashboard authors. Use this file to answer: "From what date is this event or property trustworthy enough to chart?"

This file records operational availability. Event contracts still live in `src/shared/telemetry-events.ts`, and dashboard/query examples live with the dashboard work that introduced them.

## How To Use

- Prefer `dashboard_ready_at_utc` as the lower bound for saved PostHog retention, funnel, and cohort tiles.
- If `dashboard_ready_at_utc` is `TBD`, do not save production cohort or retention tiles. QA/exploratory charts may proceed only after checking first-seen evidence, and their descriptions must say the boundary is not final.
- Use the latest required first-valid timestamp when a dashboard depends on multiple signals. An earlier timestamp may prove one event exists while a join key or depth field is still absent, which silently biases cohorts.
- Do not save a cohort chart from one isolated first-seen row.
- Mention rollout boundaries in saved insight descriptions when querying across pre-rollout data.
- Do not add these timestamps to telemetry payloads. They are repo-side interpretation metadata.

## Boundary Fields

| Field                    | Meaning                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `code_merged_at_utc`     | When the implementation reached `main`. Useful for source history only.                                                    |
| `first_released_at_utc`  | First release commit/build that contains the code. This is the earliest possible user exposure.                            |
| `first_seen_at_utc`      | First observed PostHog row for the event/property. This proves at least one event flowed.                                  |
| `dashboard_ready_at_utc` | Earliest lower bound for saved dashboards after all required signals have first-valid rows and pass any validation window. |

First-valid means the released app version has been observed, the required event/property fields are populated, joins used by the dashboard are available, and any validation window listed in the rollout entry has passed.

D1+/D3+/D7+ retention means the user fired `app_opened` at least once after 24/72/168 hours from cohort start, matching the existing dashboards' mature-denominator logic. Do not read D3/D7 as exactly-on-day returns, and do not include users whose cohort start is too recent to satisfy the relevant window.

## Cross-Cutting Rules

- `app_opened` is the return marker. It fires once per app session after telemetry consent/gating resolves.
- `nth_repo_added = 0` means the user had no repos at emit time. It is not a missing-value sentinel.
- Missing `nth_repo_added` means the classifier failed soft or the event predates the property. Do not bucket it with `0`.
- Main injects `nth_repo_added` only into schemas that declare the field, and injects onboarding `cohort` only into schemas that declare `cohort`.
- `onboarding_started { cohort: 'fresh_install' }` is the fresh-install anchor. `upgrade_backfill` rows should not be mixed into new-user onboarding funnels.
- Classify a user's fresh-install onboarding cohort from the first `onboarding_started { cohort: 'fresh_install' }` and carry that forward. Existing-user classification can flip after live completion is persisted, so later event-level `cohort` values are not a replacement for the start anchor.
- Numeric onboarding step values are rollout-specific. Prefer `value_kind` when the relevant event/property is available.
- Current `onboarding_step_skipped` means an optional preference/setup step was skipped toward required project setup. It does not mean the user abandoned repo setup.
- `source = 'unknown'` is not a real product surface. It means the caller omitted a source or the value failed schema validation.
- `workspace_created` means create-worktree IPC succeeded. It is not a general "usable workspace exists" or "workspace revealed" marker.
- `add_repo_setup_step_action` is a historical post-add choice-screen event. Current Add Project flows auto-open the default checkout or reveal the project row, so absence of this event after the default-checkout handoff rollout is expected and should not be read as setup abandonment.
- `add_repo_existing_workspaces_detected` is a detection signal for migration opportunity, not proof that a user chose an existing workspace. Current Add Project flows may emit it before automatically opening the default checkout.
- `add_repo_default_checkout_handoff.result = 'revealed_project'` means Orca could not confidently open the default checkout and instead revealed the newly added project row. It is the direct fallback metric for the 2026-06-03 Add Project handoff rollout.
- `agent_started` means PTY spawn succeeded with agent telemetry attached. It is not first-repo activation and does not prove the user sent a prompt.
- `agent_prompt_sent` means a live agent hook observed an explicit non-empty user prompt. It excludes hydrated/replayed status, agent auto-start, bare shells, draft prefill, and hookless sessions; missing rows mean no hook-confirmed interaction was observed, not proof the user never typed.
- Workspace-outcome joins are native Electron coverage unless the query explicitly proves remote/web instrumentation. Remote runtime and web paths can bypass native repo/worktree telemetry, so do not interpret missing workspace outcome rows as product drop-off for SSH, remote, or web users.

## Rollouts

### 2026-05-08 - Repo Cohort Property

Scope: `nth_repo_added` on repo/activation/retention events. Current schemas declare it on `app_opened`, `repo_added`, `add_repo_setup_step_action`, `add_repo_existing_workspaces_detected`, `add_repo_default_checkout_handoff`, `workspace_created`, `workspace_create_failed`, `setup_script_prompt_shown`, `setup_script_prompt_action`, `agent_started`, `agent_prompt_sent`, and `agent_error`. The original rollout covered `app_opened`, `repo_added`, `add_repo_setup_step_action`, `workspace_created`, `workspace_create_failed`, `agent_started`, and `agent_error`; later events have their own first-seen timestamps below.

| Field                        | Value                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR                           | `#1591`                                                                                                                                                                                  |
| Merge commit                 | `002e2acc38cad262d694049cc86c0962ffd381ce`                                                                                                                                               |
| `code_merged_at_utc`         | `2026-05-08T17:50:44Z`                                                                                                                                                                   |
| First release                | `v1.3.42-rc.1`                                                                                                                                                                           |
| First release commit         | `b6dab85aaa0e9b600ec93846824ba815542a1e1e`                                                                                                                                               |
| `first_released_at_utc`      | `2026-05-08T17:56:35Z`                                                                                                                                                                   |
| Earliest `first_seen_at_utc` | `2026-05-08T18:40:00.354Z` on `app_opened`                                                                                                                                               |
| `dashboard_ready_at_utc`     | Event-dependent. Use `2026-05-08T18:40:00.354Z` for general `app_opened` repo-count cuts; use `2026-05-08T20:01:06.364Z` or later for first-repo activation cuts requiring `repo_added`. |

PostHog evidence checked at `2026-05-23T23:34:32Z`:

| Event                                   | First seen with `nth_repo_added`           |
| --------------------------------------- | ------------------------------------------ |
| `app_opened`                            | `2026-05-08T18:40:00.354Z` (`1.3.42-rc.1`) |
| `workspace_created`                     | `2026-05-08T19:15:06.913Z`                 |
| `agent_started`                         | `2026-05-08T19:15:07.130Z`                 |
| `agent_prompt_sent`                     | `TBD`                                      |
| `repo_added`                            | `2026-05-08T20:01:06.364Z` (`1.3.42`)      |
| `add_repo_setup_step_action`            | `2026-05-08T20:01:20.897Z`                 |
| `workspace_create_failed`               | `2026-05-08T23:04:32.315Z`                 |
| `agent_error`                           | `2026-05-13T14:13:16.096Z`                 |
| `add_repo_existing_workspaces_detected` | `2026-05-20T05:33:20.160Z`                 |
| `add_repo_default_checkout_handoff`     | `TBD`                                      |
| `setup_script_prompt_shown`             | `2026-05-21T04:09:04.231Z`                 |
| `setup_script_prompt_action`            | `2026-05-21T04:10:31.616Z`                 |

Dashboard caveats:

- Earlier rows do not have `nth_repo_added`; show them as pre-rollout or exclude them from repo-count cohorts.
- A dashboard that depends on a specific event must use that event's first-seen timestamp, not the earliest `app_opened` timestamp.
- `repo_added nth_repo_added = 1` is the first-repo activation marker.
- `add_repo_setup_step_action` is only representative of the old post-add choice-screen funnel. After the 2026-06-03 default-checkout handoff change below, Add Project no longer shows that choice screen during the normal Git add/clone/create/onboarding paths.

### 2026-05-09 - Onboarding Cohort Injection

Scope: `cohort` on onboarding events. Current schemas declare it on `onboarding_started`, `onboarding_step_viewed`, `onboarding_step_completed`, `onboarding_step_skipped`, `onboarding_tour_outcome`, `onboarding_step4_path_clicked`, `onboarding_step4_path_failed`, `onboarding_task_sources_snapshot`, `onboarding_completed`, `onboarding_dismissed`, `onboarding_agent_picked`, onboarding import/setup events, `onboarding_feature_setup_toggled`, `onboarding_feature_setup_run`, `onboarding_feature_setup_terminal_opened`, and `onboarding_feature_setup_terminal_interacted`. See `src/shared/telemetry-events.ts` for the exact current roster.

The original `#1608` rollout covered `onboarding_started`, `onboarding_step_viewed`, `onboarding_step_completed`, `onboarding_step_skipped`, `onboarding_step4_path_clicked`, `onboarding_step4_path_failed`, `onboarding_completed`, `onboarding_dismissed`, `onboarding_agent_picked`, and onboarding import events. Later onboarding events joined the roster by declaring `cohort` in their schemas.

| Field                        | Value                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR                           | `#1608`                                                                                                                                                    |
| Merge commit                 | `318e2b4c2c501b50280dc9e5b11ed34bd899bdd9`                                                                                                                 |
| `code_merged_at_utc`         | `2026-05-09T02:57:18Z`                                                                                                                                     |
| First release                | `v1.3.44`                                                                                                                                                  |
| First release commit         | `e602decf1d35dc54c84eea516fc2b9afdc065cce`                                                                                                                 |
| `first_released_at_utc`      | `2026-05-09T08:05:39Z`                                                                                                                                     |
| Earliest `first_seen_at_utc` | `2026-05-09T09:54:03.038Z` on `onboarding_started { cohort: 'fresh_install' }` (`1.3.45`)                                                                  |
| `dashboard_ready_at_utc`     | `2026-05-09T09:54:03.038Z` for fresh-install onboarding-start cohorts; use later event-specific first-seen timestamps where a tile requires another event. |

Later onboarding cohort events:

| Event                                          | PR                                                   | First release                           | `first_seen_at_utc`                       |
| ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| `onboarding_feature_setup_run`                 | `#1853` (`2e5ac1c8ebdc93f6281622d9e4ef60ab14c71096`) | `v1.4.2-rc.1` at `2026-05-14T22:23:46Z` | `2026-05-15T05:55:37.248Z` (`1.4.2-rc.4`) |
| `onboarding_feature_setup_terminal_opened`     | `#1853` (`2e5ac1c8ebdc93f6281622d9e4ef60ab14c71096`) | `v1.4.2-rc.1` at `2026-05-14T22:23:46Z` | `2026-05-15T05:55:37.261Z` (`1.4.2-rc.4`) |
| `onboarding_feature_setup_terminal_interacted` | `#1853` (`2e5ac1c8ebdc93f6281622d9e4ef60ab14c71096`) | `v1.4.2-rc.1` at `2026-05-14T22:23:46Z` | `2026-05-15T11:47:28.022Z` (`1.4.2-rc.6`) |
| `onboarding_feature_setup_toggled`             | `#1853` (`2e5ac1c8ebdc93f6281622d9e4ef60ab14c71096`) | `v1.4.2-rc.1` at `2026-05-14T22:23:46Z` | `2026-05-17T03:03:54.535Z` (`1.4.3`)      |
| `onboarding_task_sources_snapshot`             | `#2275` (`ececd27fd8203a7acb3e430fa016fb4653aaa93c`) | `v1.4.7-rc.1` at `2026-05-19T00:47:11Z` | `2026-05-19T04:18:23.872Z` (`1.4.7`)      |

Dashboard caveats:

- Use `onboarding_started { cohort: 'fresh_install' }` as the new-user denominator.
- Keep the single observed `upgrade_backfill` rows out of fresh-install funnels.
- `onboarding_step_completed` had semantic `value_kind` before the tour instrumentation, but `onboarding_step_viewed` and `onboarding_step_skipped` only became semantic-step-safe with the tour telemetry rollout below.
- Later onboarding events joined the `cohort` roster by declaring `cohort` in their schema. Use event-specific first-seen timestamps for tiles that depend on those later events.
- `onboarding_task_sources_snapshot` fires only when the integrations step exits through Continue or Skip to project setup. Viewing integrations and leaving does not emit the snapshot.
- Old numeric step analysis must be scoped to the flow version being analyzed.

### 2026-05-14 - Feature Wall Base Telemetry

Scope: first feature-wall tour event family before the inline onboarding tour. This added base open/close and tile activity telemetry. Historical `feature_wall_closed` rows from this rollout have `dwell_ms`; the source/depth fields needed for tour cohort retention only arrive in the later tour telemetry rollout.

| Field                    | Value                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| PR                       | `#1772`                                                                                                          |
| Merge commit             | `fdf7d9e97a46f27b3667d9bae6c8aca5d11345d8`                                                                       |
| `code_merged_at_utc`     | `2026-05-14T22:20:50Z`                                                                                           |
| First release            | `v1.4.2-rc.1`                                                                                                    |
| First release commit     | `c66e9801fe5f159cac23564ec7c028957973692a`                                                                       |
| `first_released_at_utc`  | `2026-05-14T22:23:46Z`                                                                                           |
| `first_seen_at_utc`      | `2026-05-15T06:15:30.263Z` on `feature_wall_opened { source: 'popup' }` (`1.4.2-rc.4`)                           |
| `dashboard_ready_at_utc` | Event-dependent. Useful for base feature-wall usage after first-seen rows, not for inline-tour cohort retention. |

PostHog evidence checked at `2026-05-23T23:34:32Z`:

| Event/property                                    | `first_seen_at_utc`                       |
| ------------------------------------------------- | ----------------------------------------- |
| `feature_wall_opened { source: 'popup' }`         | `2026-05-15T06:15:30.263Z` (`1.4.2-rc.4`) |
| `feature_wall_tile_focused`                       | `2026-05-15T06:15:31.073Z` (`1.4.2-rc.4`) |
| `feature_wall_closed` with legacy `dwell_ms` only | `2026-05-15T06:18:22.677Z`                |
| `feature_wall_tile_clicked`                       | `2026-05-17T04:35:04.142Z` (`1.4.3`)      |
| `feature_wall_opened { source: 'help_menu' }`     | `2026-05-17T07:02:23.278Z` (`1.4.3`)      |

Dashboard caveats:

- Do not infer inline onboarding tour cohorts from this rollout.
- Historical `feature_wall_closed` null `source`/depth fields are pre-rollout absence, not product behavior.

### 2026-05-23 - Inline Tour Surface

Scope: optional "Explore Orca" tour during onboarding and the Help menu entry point. This shipped the product surface, not the full retention cohort instrumentation. It also added `source = 'onboarding'` to the feature-wall open source enum and added feature-wall group/feature/docs click events with source.

| Field                      | Value                                                                        |
| -------------------------- | ---------------------------------------------------------------------------- |
| PR                         | `#2652`                                                                      |
| Merge commit               | `669ade23133b9905fff1b6ed22755ee2911ea517`                                   |
| `code_merged_at_utc`       | `2026-05-23T19:21:14Z`                                                       |
| First release              | `v1.4.23-rc.0`                                                               |
| First release commit       | `1f1171e0dee5d0fbf969de56845882bf8deb9037`                                   |
| `first_released_at_utc`    | `2026-05-23T20:14:38Z`                                                       |
| First app version observed | `1.4.23-rc.0` at `2026-05-23T20:54:12.343Z`                                  |
| `dashboard_ready_at_utc`   | `TBD`; do not use this surface-only rollout for tour cohort retention tiles. |

Dashboard caveats:

- `feature_wall_opened { source: 'onboarding' }` is a release-availability signal for the inline surface, not the canonical tour cohort assignment.
- Use this boundary only for exploratory checks that do not require the new outcome/depth fields.
- Tour cohorts are observational and self-selected. Do not use causal "lift" or "impact" language unless a separate experiment supports it.

### 2026-05-23 - Onboarding Tour Retention Telemetry

Scope: low-cardinality telemetry that makes inline-tour cohort retention dashboards possible.

Current status: the inline first-run onboarding tour was later removed from active onboarding after PR #2734 moved these education/setup moments to contextual feature tours and the Getting started with Orca guide. The historical schemas still accept seven-step `tour`/`agent_setup` onboarding rows for compatibility, but current active onboarding should not emit new `onboarding_step_* { value_kind: 'tour' }` rows.

Added/changed signals:

- `onboarding_tour_outcome` with `outcome`, intro/tour duration fields, optional tour depth fields, `advanced_via`, and injected onboarding `cohort`.
- `onboarding_step_viewed.value_kind` and `onboarding_step_skipped.value_kind`, including `value_kind = 'tour'`.
- `feature_wall_closed` optional `source`, `exit_action`, `furthest_step`, `last_group_id`, and bounded visited/completed depth counts.
- `feature_wall_opened { source: 'onboarding' }` through the inline tour surface.

| Field                    | Value                                      |
| ------------------------ | ------------------------------------------ |
| PR                       | `#2713`                                    |
| Branch commit            | `9115143927dce38547545a07e58b85d17796fd7a` |
| Merge commit             | `b9c55bb07127f799528761ec31d7e2b7f8598c07` |
| `code_merged_at_utc`     | `2026-05-23T21:15:11Z`                     |
| First release            | `v1.4.23-rc.1`                             |
| First release commit     | `c74765922e770c6540496735a5a2be838457256a` |
| `first_released_at_utc`  | `2026-05-23T21:16:38Z`                     |
| `first_seen_at_utc`      | `TBD`                                      |
| `dashboard_ready_at_utc` | `TBD`                                      |

Required readiness signals:

| Signal                                                                                 | `first_seen_at_utc`                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `onboarding_tour_outcome` with valid `outcome` and joinable fresh-install start        | `TBD`                                                                                |
| `onboarding_step_viewed { value_kind: 'tour' }`                                        | Historical only; no new active-onboarding rows after the PR #2734 education handoff. |
| `feature_wall_closed` with non-null `source`, `exit_action`, and expected depth fields | `TBD`                                                                                |

QA/opportunistic signals:

| Signal                                           | `first_seen_at_utc`                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `onboarding_step_skipped { value_kind: 'tour' }` | Historical only; do not gate dashboard readiness on natural skip traffic. |
| `feature_wall_opened { source: 'onboarding' }`   | `TBD`; surface availability only.                                         |

PostHog evidence checked at `2026-05-23T23:34:32Z`:

- `1.4.23-rc.0` had app traffic from `2026-05-23T20:54:12.343Z` through `2026-05-23T22:59:47.599Z`.
- No `1.4.23-rc.1` or `1.4.23-rc.2` app traffic was observed in the checked query window.
- No rows were observed for `onboarding_tour_outcome`, `onboarding_step_viewed { value_kind: 'tour' }`, `onboarding_step_skipped { value_kind: 'tour' }`, `feature_wall_opened { source: 'onboarding' }`, or `feature_wall_closed` with the new source/depth fields.
- No rows were observed for `feature_wall_group_selected`, `feature_wall_feature_selected`, or `feature_wall_docs_clicked` in the checked query window.

Dashboard readiness rule:

Set this rollout's `dashboard_ready_at_utc` to the latest first-valid timestamp across the required readiness signals, then use that as the lower bound. If a query uses a local variable, name it `tour_telemetry_ready_at_utc` and assign it to the same value. After first-seen rows exist, keep saved cohort tiles in QA/exploratory mode until there is at least a 24-hour validation window where reached-tour users reconcile to exactly one primary inline cohort and closed tour sessions include depth fields.

Invalid before this rollout's `dashboard_ready_at_utc`:

- Tour cohort onboarding completion/progress.
- Corrected onboarding outcome split by tour cohort.
- Tour depth before abandonment.
- Skipped-tour later Help recovery.
- D1/D3/D7 retention by tour cohort, until cohorts are also old enough for each maturity window.
- Numeric-step max-progress charts unless segmented by rollout or app version.

Primary cohort interpretation:

- Historical denominator for inline completed/partial/skipped rates: `onboarding_step_viewed { value_kind: 'tour' }` after this rollout's `dashboard_ready_at_utc`. Do not use this as a current active-onboarding readiness signal after the PR #2734 education handoff.
- `onboarding_tour_outcome.outcome = 'completed_inline'` means the user completed the inline tour during fresh onboarding.
- `onboarding_tour_outcome.outcome = 'started_partial'` means the user started the inline tour but the fresh onboarding session resolved without inline completion.
- `onboarding_tour_outcome.outcome = 'skipped_intro'` means the user reached the tour intro and skipped without starting the inline tour.
- Users who started onboarding but never reached the tour intro are `pre_tour_abandoned`, not `unresolved_inline_outcome`.
- Users who reached the tour intro but have no outcome event are `unresolved_inline_outcome`; monitor this as a telemetry QA gap.
- Later Help menu tour usage is an overlay on the user's inline cohort. It does not replace the primary inline outcome.
- `completed_inline` wins over earlier partial state if the user returns and completes during the fresh onboarding session.
- `started_partial` resolves only after the user started the inline tour and the fresh onboarding session resolves without inline completion.
- `skipped_intro` intentionally has no `tour_dwell_ms` or depth fields.

Feature-wall close interpretation:

- `feature_wall_closed.dwell_ms` is session-close dwell time.
- `feature_wall_closed.source` is the entry point (`onboarding`, `help_menu`, `popup`, or `unknown`).
- `exit_action = 'onboarding_continue'` means the inline onboarding tour ended through Continue to project setup.
- `exit_action = 'done'` means a non-onboarding tour session ended through Done.
- `exit_action = 'dismissed'` is the default close/unmount path.
- Depth fields are per explicit tour session. Persisted completion state can affect UI progress but must not be interpreted as current-session depth.
- Missing/null `feature_wall_closed.source` or depth fields mean the row predates the expanded schema, came from an older app version, or failed field coverage. Do not bucket null with `source = 'unknown'`; exclude it from source/depth cohort tiles or show it as a telemetry coverage gap.

### 2026-06-02 - Active Onboarding Step Removal

Scope: active first-run onboarding no longer emits the `agent_setup` or `tour` semantic steps. The removed "Set up Orca for agents" and "Explore Orca" education/setup moments are covered by PR #2734 through contextual feature tours and the Getting started with Orca guide.

This is a product-flow and telemetry-interpretation boundary, not a new event rollout. Historical onboarding schemas still accept seven-step `agent_setup` and `tour` rows so old data remains queryable, but dashboard authors should not expect new active-onboarding rows for those semantic steps after this rollout.

| Field                    | Value                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| PR                       | `#4445`                                                                         |
| Merge commit             | `TBD`                                                                           |
| `code_merged_at_utc`     | `TBD`                                                                           |
| First release            | `TBD`                                                                           |
| First release commit     | `TBD`                                                                           |
| `first_released_at_utc`  | `TBD`                                                                           |
| `first_seen_at_utc`      | N/A                                                                             |
| `dashboard_ready_at_utc` | Event-dependent; use this as a cutoff only after the PR is merged and released. |

Dashboard caveats:

- Treat `onboarding_step_* { value_kind: 'agent_setup' }`, `onboarding_step_* { value_kind: 'tour' }`, and `onboarding_tour_outcome` as historical first-run onboarding signals after this rollout.
- Do not use absence of new `agent_setup` or `tour` onboarding rows as a drop-off signal; those steps no longer exist in active onboarding.
- Segment numeric onboarding step analysis across this boundary. The active final step changed from seven-step onboarding to the five-step active flow.
- Continue using `contextual_tour_shown` and `contextual_tour_outcome` from PR #2734 for current feature-education exposure and outcome analysis.

### 2026-06-03 - Final Code Onboarding Step Removal

Scope: active first-run onboarding no longer emits the final code/project picker step. The notifications step is now the final step, and completing it opens the Add Project modal.

This is a product-flow and telemetry-interpretation boundary, not a new event rollout. Historical onboarding schemas still accept five-step rows so old data remains queryable, but dashboard authors should not expect new active-onboarding rows for the removed final code/project picker step after this rollout.

| Field                    | Value                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| PR                       | `#4524`                                                                         |
| Merge commit             | `TBD`                                                                           |
| `code_merged_at_utc`     | `TBD`                                                                           |
| First release            | `TBD`                                                                           |
| First release commit     | `TBD`                                                                           |
| `first_released_at_utc`  | `TBD`                                                                           |
| `first_seen_at_utc`      | N/A                                                                             |
| `dashboard_ready_at_utc` | Event-dependent; use this as a cutoff only after the PR is merged and released. |

Dashboard caveats:

- Treat `onboarding_step_*` rows for the removed final code/project picker step as historical first-run onboarding signals after this rollout.
- Segment numeric onboarding step analysis across this boundary. The active final step changed from the five-step active flow to `ONBOARDING_FINAL_STEP = 4`.
- Do not use absence of new final code/project picker rows as a drop-off signal; that step no longer exists in active onboarding.

### 2026-06-03 - Add Project Default Checkout Handoff

Scope: Add Project handoff telemetry and interpretation change. The Git add/clone/create/onboarding flows no longer show the post-add setup-choice screen; they close the add modal and open the project/default checkout when available. If no default checkout is available, they reveal the project row instead.

`repo_added` remains the add/import marker. `add_repo_existing_workspaces_detected` remains a low-cardinality detection event for pre-existing non-main workspaces on local folder, runtime server path, and SSH server path adds. `add_repo_default_checkout_handoff` is the direct rollout-health event for the automatic handoff decision.

| Field                    | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| PR                       | `#4530`                                                                               |
| Merge commit             | `TBD`                                                                                 |
| `code_merged_at_utc`     | `TBD`                                                                                 |
| First release            | `TBD`                                                                                 |
| First release commit     | `TBD`                                                                                 |
| `first_released_at_utc`  | `TBD`                                                                                 |
| `first_seen_at_utc`      | `TBD` on `add_repo_default_checkout_handoff`                                          |
| `dashboard_ready_at_utc` | Use the first release boundary once known for charts that compare setup-choice usage. |

Dashboard caveats:

- Treat `add_repo_setup_step_action` rows after this rollout as historical compatibility or stale modal cleanup only, not the normal Add Project funnel.
- Do not build current-flow conversion funnels that require `repo_added -> add_repo_setup_step_action`; the normal next step is an automatic workspace reveal/open, not a tracked user choice.
- Use `add_repo_existing_workspaces_detected` to estimate how often added projects had non-main existing workspaces, but do not infer the user selected "use existing worktrees" because that choice no longer exists in the normal flow.
- Use `add_repo_default_checkout_handoff` for the current handoff outcome. `result = 'opened_default_checkout'` is the expected path; `result = 'revealed_project'` is the graceful fallback. Break down fallback rows by `source` and `reason`.

## Updating This File

When adding or changing telemetry that dashboard authors will depend on:

1. Add or update one rollout entry in this file.
2. Record PR, merge commit, first release, release commit, `first_released_at_utc`, `first_seen_at_utc`, and `dashboard_ready_at_utc`.
3. Include the app version/build on first-seen rows when it is available.
4. Add `PostHog evidence checked at ...` with the UTC query time.
5. If dashboard readiness depends on multiple signals, add a required readiness signal table and set `dashboard_ready_at_utc` only after all of them are first-valid.
6. Add dashboard caveats for pre-rollout rows, missing/null fields, and maturity windows.
7. Keep product-specific facts here, not in agent instructions or telemetry payloads.
