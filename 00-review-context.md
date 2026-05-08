# Review Context

## Branch Info
- Base: origin/main
- Current: create-onboarding
- Merge base: b9333335007e0648c4d5bb0f6710d7940389af30

## Changed Files Summary
- A config/scripts/dev-fresh-profile.sh
- A docs/design/onboarding-flow-mockup.html
- A docs/design/onboarding-flow.md
- M src/main/index.ts
- M src/main/ipc/notifications.ts
- A src/main/ipc/onboarding.ts
- M src/main/ipc/register-core-handlers.ts
- M src/main/persistence.ts
- M src/preload/api-types.ts
- M src/preload/index.ts
- M src/renderer/src/App.tsx
- A src/renderer/src/components/onboarding/AgentStep.tsx
- A src/renderer/src/components/onboarding/NotificationStep.tsx
- A src/renderer/src/components/onboarding/OnboardingFlow.tsx
- A src/renderer/src/components/onboarding/RepoStep.tsx
- A src/renderer/src/components/onboarding/ThemeStep.tsx
- A src/renderer/src/components/onboarding/should-show-onboarding.ts
- A src/renderer/src/components/onboarding/use-onboarding-flow.ts
- M src/renderer/src/hooks/useComposerState.ts
- A src/renderer/src/lib/editable-target.ts
- M src/shared/constants.ts
- M src/shared/telemetry-events.ts
- M src/shared/types.ts
- M tests/e2e/helpers/orca-app.ts
- A tests/e2e/onboarding.spec.ts

## Changed Line Ranges (PR Scope)
| File | Changed Lines |
|------|---------------|
| config/scripts/dev-fresh-profile.sh | 1-43 (new) |
| docs/design/onboarding-flow-mockup.html | 1-798 (new) |
| docs/design/onboarding-flow.md | 1-305 (new) |
| src/main/index.ts | 590-593 |
| src/main/ipc/notifications.ts | 8, 35-36, 46-64 |
| src/main/ipc/onboarding.ts | 1-16 (new) |
| src/main/ipc/register-core-handlers.ts | 20, 87 |
| src/main/persistence.ts | 15-16, 24, 236-275, 644-671 |
| src/preload/api-types.ts | 47-50, 756-770 |
| src/preload/index.ts | 24, 28, 906-910, 971-979 |
| src/renderer/src/App.tsx | 26, 41, 49, 61-65, 146, 234-237, 1117-1121 |
| src/renderer/src/components/onboarding/AgentStep.tsx | 1-127 (new) |
| src/renderer/src/components/onboarding/NotificationStep.tsx | 1-75 (new) |
| src/renderer/src/components/onboarding/OnboardingFlow.tsx | 1-202 (new) |
| src/renderer/src/components/onboarding/RepoStep.tsx | 1-104 (new) |
| src/renderer/src/components/onboarding/ThemeStep.tsx | 1-324 (new) |
| src/renderer/src/components/onboarding/should-show-onboarding.ts | 1-24 (new) |
| src/renderer/src/components/onboarding/use-onboarding-flow.ts | 1-397 (new) |
| src/renderer/src/hooks/useComposerState.ts | 1339-1344, 1542-1543 |
| src/renderer/src/lib/editable-target.ts | 1-7 (new) |
| src/shared/constants.ts | 4, 115-136, 266-267 |
| src/shared/telemetry-events.ts | 81, 94, 192-250, 276-286 |
| src/shared/types.ts | 1316-1350, 1553 |
| tests/e2e/helpers/orca-app.ts | 40-54, 56-60, 152-167, 170-171 |
| tests/e2e/onboarding.spec.ts | 1-245 (new) |

## Review Standards Reference
- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories
- **Backend/API** (priority 4):
  - src/main/index.ts
  - src/main/ipc/notifications.ts
  - src/main/ipc/onboarding.ts
  - src/main/ipc/register-core-handlers.ts
  - src/main/persistence.ts
  - src/preload/api-types.ts
  - src/preload/index.ts
- **Frontend/UI** (priority 5):
  - src/renderer/src/App.tsx
  - src/renderer/src/components/onboarding/AgentStep.tsx
  - src/renderer/src/components/onboarding/NotificationStep.tsx
  - src/renderer/src/components/onboarding/OnboardingFlow.tsx
  - src/renderer/src/components/onboarding/RepoStep.tsx
  - src/renderer/src/components/onboarding/ThemeStep.tsx
  - src/renderer/src/components/onboarding/should-show-onboarding.ts
  - src/renderer/src/components/onboarding/use-onboarding-flow.ts
  - src/renderer/src/hooks/useComposerState.ts
  - src/renderer/src/lib/editable-target.ts
- **Config/Build** (priority 6):
  - config/scripts/dev-fresh-profile.sh
- **Utility/Common** (priority 7):
  - src/shared/constants.ts
  - src/shared/telemetry-events.ts
  - src/shared/types.ts
  - tests/e2e/helpers/orca-app.ts
  - tests/e2e/onboarding.spec.ts
  - docs/design/onboarding-flow-mockup.html (docs - skip review)
  - docs/design/onboarding-flow.md (docs - skip review)

## Skipped Issues (Do Not Re-validate)

(Initially empty)

## Iteration State
Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
