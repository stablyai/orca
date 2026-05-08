# Review Context

## Branch Info
- Base: origin/main (merge-base)
- Current: create-onboarding

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
- A src/renderer/src/components/onboarding/use-onboarding-flow.ts
- M src/renderer/src/hooks/useComposerState.ts
- M src/shared/constants.ts
- M src/shared/telemetry-events.ts
- M src/shared/types.ts
- M tests/e2e/helpers/orca-app.ts
- A tests/e2e/onboarding.spec.ts

## Changed Line Ranges (PR Scope)
| File | Changed Lines |
|------|---------------|
| config/scripts/dev-fresh-profile.sh | 1-31 (entire file new) |
| src/main/index.ts | 590-593 |
| src/main/ipc/notifications.ts | 8, 35-36, 46-64 |
| src/main/ipc/onboarding.ts | 1-16 (entire file new) |
| src/main/ipc/register-core-handlers.ts | 20, 87 |
| src/main/persistence.ts | 23, 235-257, 626-653 |
| src/preload/api-types.ts | 47, 49, 756-757, 760-763 |
| src/preload/index.ts | 24, 28, 906-909, 971-976 |
| src/renderer/src/App.tsx | 26, 48, 163, 251-254, 1134-1136 |
| src/renderer/src/components/onboarding/AgentStep.tsx | 1-125 (entire file new) |
| src/renderer/src/components/onboarding/NotificationStep.tsx | 1-72 (entire file new) |
| src/renderer/src/components/onboarding/OnboardingFlow.tsx | 1-197 (entire file new) |
| src/renderer/src/components/onboarding/RepoStep.tsx | 1-87 (entire file new) |
| src/renderer/src/components/onboarding/ThemeStep.tsx | 1-319 (entire file new) |
| src/renderer/src/components/onboarding/use-onboarding-flow.ts | 1-344 (entire file new) |
| src/renderer/src/hooks/useComposerState.ts | 1339-1341, 1344, 1542-1543 |
| src/shared/constants.ts | 4, 115-136, 266-267 |
| src/shared/telemetry-events.ts | 81, 94, 192-246, 272-282 |
| src/shared/types.ts | 1316-1345, 1548 |
| tests/e2e/helpers/orca-app.ts | 41-45, 137-146, 149-150 |
| tests/e2e/onboarding.spec.ts | 1-225 (entire file new) |

## Review Standards Reference
- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### AI/Agent: (none)

### CLI: (none)

### Database/Schema: (none)

### Backend/API:
- src/main/index.ts
- src/main/ipc/notifications.ts
- src/main/ipc/onboarding.ts
- src/main/ipc/register-core-handlers.ts
- src/main/persistence.ts
- src/preload/api-types.ts
- src/preload/index.ts

### Frontend/UI:
- src/renderer/src/App.tsx
- src/renderer/src/components/onboarding/AgentStep.tsx
- src/renderer/src/components/onboarding/NotificationStep.tsx
- src/renderer/src/components/onboarding/OnboardingFlow.tsx
- src/renderer/src/components/onboarding/RepoStep.tsx
- src/renderer/src/components/onboarding/ThemeStep.tsx
- src/renderer/src/components/onboarding/use-onboarding-flow.ts
- src/renderer/src/hooks/useComposerState.ts

### Config/Build:
- config/scripts/dev-fresh-profile.sh

### Utility/Common:
- src/shared/constants.ts
- src/shared/telemetry-events.ts
- src/shared/types.ts
- tests/e2e/helpers/orca-app.ts
- tests/e2e/onboarding.spec.ts

## Skipped Issues (Do Not Re-validate)
<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

## Iteration State
Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
