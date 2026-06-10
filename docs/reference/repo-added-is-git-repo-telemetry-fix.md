# `repo_added.is_git_repo` — fixing the git-vs-folder onboarding signal

## Symptom

The PostHog dashboard tile "Fresh-install onboarding completion over time" (insight `JlIt5J1N`, insight id 9076383, project 406068) showed the git-repo completion share collapse to ~4% while plain-folder completions spiked to ~88% on 2026-06-05. This looked like users suddenly stopped onboarding with real git repos — but it was an instrumentation regression, not a behavior change.

## Root cause

The `onboarding_completed` event carried `is_git_repo: boolean`, but it was never a real git detection. It was computed at the emit site as `checklist.addedRepo === true` — a proxy that only worked while onboarding contained an in-flow repo-picker step that populated `checklist.addedRepo`.

The Add Project flow changes (PRs #4445 "remove covered onboarding steps", #4524 "remove final code onboarding step", #4530 "simplify project add handoff") removed that in-onboarding repo-picker step. Onboarding's final step is now "notifications"; completing it calls `closeWith('completed', {}, ONBOARDING_FINAL_STEP, 'add_project_modal')` with an empty checklist and then auto-opens the Add Project modal. Project selection now happens *after* `onboarding_completed` fires, in that modal. So `checklist.addedRepo` is always `undefined` at emit time, making `is_git_repo` always `false`.

## PostHog evidence (version cliff)

Raw `onboarding_completed.is_git_repo` counts by `app_version` show a clean cliff exactly at the release that removed the repo-picker step:

- versions ≤ 1.4.45: ≈ 80% `true`
- 1.4.46: 0/52 `true`
- 1.4.47: 0/10 `true`
- 1.4.48: 0/118 `true`

This is a regression, not user behavior: the signal source disappeared, it was not that users stopped adding git repos.

## The fix

Move the git-vs-folder signal to where project selection actually happens now — the `repo_added` event — and source it from real git detection at the add point.

- Added `is_git_repo: z.boolean().optional()` to `repoAddedSchema` in `src/shared/telemetry-events.ts`. Optional (fail-soft, matching `nthRepoAddedSchema`) so SSH/remote or any path that genuinely can't determine git-ness validates cleanly rather than crashing the track call.
- Threaded the git-repo boolean through `emitRepoAdded(method, alreadyExisted, isGitRepo?)` in `src/main/ipc/repos.ts`. Each call site passes the git signal it already has in scope: `clone_url` paths are always `true`; `folder_picker` / `repos:create` paths pass `repoKind === 'git'`, which already reflects the SSH/remote-aware `gitProvider.isGitRepoAsync` result (remote add) or the local `isGitRepo` check / git-init choice. No new async git I/O is performed in `emitRepoAdded`. When a call site genuinely can't know git-ness yet (the remote-add duplicate-dedup path, which runs before `isGitRepoAsync`), it passes `undefined` — never a guessed `false`, which is exactly the bug being fixed.
- Retired `is_git_repo` on `onboarding_completed`: removed it from the `track('onboarding_completed', {...})` call in `src/renderer/src/components/onboarding/use-onboarding-flow-persistence.ts` and from `onboardingCompletedSchema` in lockstep (schemas are `.strict()`, so removing from one without the other breaks validation).

## Follow-up

The PostHog dashboard tile `JlIt5J1N` (insight id 9076383, project 406068) must be re-pointed to read git-vs-folder from `repo_added.is_git_repo` once the new field flows in release telemetry. Caveat for whoever does it: the old `onboarding_completed.is_git_repo` split is invalid from 1.4.46 onward (always `false`), so any historical series built on it should be cut off at that version rather than stitched to the new `repo_added` series. Do not edit PostHog as part of this change — this is a documented follow-up only.

