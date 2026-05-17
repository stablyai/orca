# Skip to Add Project Onboarding

## Problem or Goal

The onboarding footer currently offers "Skip all onboarding" on every step. That label implies the user can leave the wizard entirely, but Orca is not useful until a repo or folder has been added. The product decision is to let users skip optional setup content, then require the final Add Project step before onboarding closes.

Goal: replace "Skip all onboarding" with a "Skip to Add Project" behavior on earlier steps, and remove any repo-step affordance that dismisses onboarding without adding, opening, or cloning a project.

## Current Behavior

- `OnboardingFlow.tsx` defines the repo subtitle as "Open a folder, clone a repo, or skip and add one later." at `src/renderer/src/components/onboarding/OnboardingFlow.tsx:31`.
- The footer always renders a "Skip all onboarding" button and wires it to `flow.skip()` at `src/renderer/src/components/onboarding/OnboardingFlow.tsx:210`.
- `useOnboardingFlow().skip()` records `onboarding_step_skipped`, reverts a previewed theme when needed, then calls `closeWith('dismissed', ...)` at `src/renderer/src/components/onboarding/use-onboarding-flow.ts:505`.
- `closeWith('dismissed', ...)` persists `closedAt`, `outcome: 'dismissed'`, `checklist.dismissed: true`, and `lastCompletedStep: -1` at `src/renderer/src/components/onboarding/use-onboarding-flow-persistence.ts:48`.
- The repo step already blocks normal `next()` navigation by returning early when `currentStep.id === 'repo'` at `src/renderer/src/components/onboarding/use-onboarding-flow.ts:338`.
- The intended repo completion path already lives in `completeRepo()`: after a project is added, it calls `closeWith('completed', ...)`, emits step 4 completion telemetry, and opens the new workspace composer for Git repos at `src/renderer/src/components/onboarding/use-onboarding-flow.ts:261`.
- Existing E2E coverage locks in the obsolete behavior: "Skip all onboarding on the repo step dismisses onboarding" at `tests/e2e/onboarding.spec.ts:527`.
- The onboarding E2E helpers scope the footer by looking for "Skip all onboarding" at `tests/e2e/onboarding.spec.ts:101`, so tests must be updated with the new label/absence behavior.

## Proposed Design

1. Rename the footer affordance on non-repo steps to "Skip to Add Project".
2. Change the skip controller behavior so it navigates to the final repo step instead of dismissing onboarding.
   - Record `onboarding_step_skipped` for the skipped current step, preserving the existing step duration and `advanced_via: 'button'` telemetry.
   - If skipping from the theme step, keep the existing preview cleanup so a temporary theme does not leak.
   - Persist open onboarding progress so a restart before project setup resumes on the repo step:
     - update onboarding state with `lastCompletedStep` set to the step immediately before repo;
     - leave `closedAt`, `outcome`, and `checklist.dismissed` unchanged;
     - call `onOnboardingChange(nextState)` with the persisted state before changing the visible step.
   - Do not persist skipped preference choices as completed settings. In particular, do not save agent, theme, notification, or feature-setup selections from the skip-to-repo path.
   - Set `stepIndex` to the `repo` step after telemetry, preview cleanup, and successful onboarding-state persistence.
   - Do not call `closeWith('dismissed', ...)` from this path.
3. Hide the skip affordance entirely on the repo step.
   - The visible footer should keep Back available when applicable.
   - There should be no button that can close onboarding from step 4 without a project.
4. Update repo-step copy to remove the false promise that users can skip and add later.
   - Suggested subtitle: "Open a folder or clone a repo to finish setup."
5. Keep project completion behavior unchanged.
   - Local folder, local Git repo, SSH/runtime server path, and clone flows should still complete onboarding through `completeRepo()`.
   - This change should not alter repo IPC, runtime RPC, or SSH-specific behavior.

Implementation shape:

- In `use-onboarding-flow.ts`, replace or rename `skip()` with a clearer controller method such as `skipToRepo()`, or keep the exported name only if minimizing churn is preferred.
- Derive the repo index from `STEPS.findIndex((step) => step.id === 'repo')` or `STEPS.length - 1` rather than hardcoding `3`.
- Derive the persisted resume value from the repo step rather than a magic number. With the current `lastCompletedStep` contract, resuming into repo means storing `repoStep.stepNumber - 1`.
- If the onboarding update fails, keep the user on the current step, surface the error through the hook's existing `error` state, and do not emit dismissal or completion telemetry.
- Add a brief "Why" comment near the new navigation path: users can skip optional preferences, but onboarding remains gated on adding a project because the app has no useful empty-project state.
- In `OnboardingFlow.tsx`, render the skip button only when `currentStep.id !== 'repo'`, and label it "Skip to Add Project".
- Update footer test helpers so they no longer require the footer to contain the old skip label.

## Edge Cases

- Busy state: skip-to-repo should remain disabled while `busyLabel` is set, matching the current skip button behavior.
- Theme preview: skipping from the theme step must revert to the persisted theme before moving to repo.
- Notifications feature setup: if setup is in progress, the disabled button should not interrupt the operation. If setup has already produced a terminal command and `busyLabel` is clear, skip-to-repo may leave that optional command review exactly like pressing Continue from that state already does.
- Repo step: no skip button is rendered, so users cannot dismiss onboarding without project setup. Back remains available so they can revisit earlier settings.
- Stepper dots: direct clicking of the repo step can still navigate there. That is acceptable because it lands on the required setup step rather than bypassing it.
- Reopened/resumed onboarding: after skip-to-repo persists progress, a renderer reload or app restart should resume into repo while still showing onboarding (`closedAt === null`). A manual onboarding reopen from the sidebar still resets to step 1 via `showOnboardingFromRenderer()`.
- SSH/runtime environment: server path open and clone destination validation must be unchanged.

## Test Plan

Playwright E2E coverage is relevant because this is visible wizard behavior and persisted onboarding state.

- Update `renders on first launch with the agent step active` to expect "Skip to Add Project" instead of "Skip all onboarding".
- Add or update an E2E test that clicks "Skip to Add Project" from step 1 and asserts:
  - the repo heading "Point Orca at some code" is visible;
  - "4 of 4" is visible;
  - onboarding state still has `closedAt === null`;
  - onboarding state has `outcome === null`, `checklist.dismissed === false`, and `lastCompletedStep === 3`;
  - no "Skip to Add Project" or "Skip all onboarding" button is visible on the repo step.
- Replace the obsolete repo-step dismissal test with a repo-step gating test:
  - advance to the repo step through the normal flow;
  - assert no skip/dismiss footer action exists;
  - assert `closedAt` remains `null`.
- Keep the existing repo keyboard/input tests unchanged except for footer helper label updates.
- Unit tests are not required unless the hook is already covered with render-hook infrastructure; the behavior is tightly coupled to React state, Electron IPC mocks, and visible UI assertions that the onboarding Playwright spec already exercises.
- Manual/Electron validation should capture screenshots for:
  - first step showing "Skip to Add Project";
  - repo step reached after clicking it;
  - repo step footer showing no skip button.

## Rollout Order

1. Update the design doc through review.
2. Change controller behavior and footer rendering/copy.
3. Update the onboarding E2E helper and affected tests.
4. Run targeted onboarding Playwright tests.
5. Run `pnpm typecheck` and `pnpm lint`.
6. Validate in Electron and save screenshots of the before-action and after-action states.
7. Commit, push, and open an unmerged PR.

## Ref-OSS

`ref-oss` was not used. This is a narrow Orca-specific onboarding copy and state-transition change; mature OSS references would not materially reduce design risk. Implementation should reuse the existing Orca onboarding controller, step definitions, telemetry calls, and E2E fixtures.
