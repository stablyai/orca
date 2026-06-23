# Feature Education State

Orca uses local persisted UI state to decide which education surfaces should appear for a user. Keep these concepts separate; they answer different questions and should not be collapsed into one flag.

For the feature-interaction catalog, see [`feature-discovery-interaction-tracking.md`](./feature-discovery-interaction-tracking.md). For retention analysis and dashboard construction, see [`feature-education-retention-analytics.md`](./feature-education-retention-analytics.md).

## State Types

`featureTipsSeenIds` answers: "Has Orca already surfaced this tip?"

Set this when a restart tip is opened, dismissed, or acted on. It prevents the same tip from reappearing after restart, crash, or dismissal. It does not mean the user used the feature.

`contextualToursSeenIds` answers: "Has Orca already surfaced this contextual tour?"

Set this after a tour has rendered a measured target, or when the user skips/completes the tour. It prevents the same tour from showing again. It does not mean the user used the feature.

`contextualToursAutoEligible` answers: "May this profile receive automatic contextual tours from this rollout?"

Missing means Orca has not classified the profile yet. On first hydrated launch after this change, the renderer sets it once:

- `true` when first-run onboarding is still open, which covers new users from this rollout forward
- `false` when onboarding is already closed, which covers existing users

Automatic contextual tours require this flag to be `true`. Existing users still get local feature interaction state recorded when they enter supported surfaces, but they are not auto-toured by this rollout.

`featureInteractions` answers: "Has the user actually interacted with this feature?"

This is the product-state signal for already-discovered features. It lives in `PersistedUIState.featureInteractions`, keyed by `FeatureInteractionId`, and stores the first local interaction timestamp plus a local interaction count:

```ts
{
  tasks: {
    firstInteractedAt: 1716500000000,
    interactionCount: 3
  }
}
```

Use this to suppress tips or tours that would teach a feature the user has already found on their own.

## Rules

- Define every trackable feature in `src/shared/feature-interactions.ts`.
- The `interaction` text must clearly state what counts as "used." Avoid vague labels like "seen" or "visited" unless passive visibility is truly the intended signal.
- Record only the first interaction. Repeated opens should not churn the user-data file.
- Record interactions only after persisted UI state is hydrated, so startup defaults cannot overwrite real user data.
- Do not rename or reuse ids. If semantics change materially, add a new id and leave the old one readable.
- Unknown or malformed persisted ids are ignored during hydration for forward/backward compatibility.
- This state is local product state, not telemetry. Analytics should use the bounded feature-education telemetry events (`contextual_tour_shown` and `contextual_tour_outcome`) plus existing downstream action events, rather than reading or uploading the persisted state blob.
- Automatic contextual tours are new-user-only for this rollout. Do not reset `contextualToursAutoEligible` for existing users unless the product decision changes for a later release.

## Adding A Tip

When a tip should not show after the user has already used the feature, add the relevant interaction id to the tip definition:

```ts
{
  id: 'voice-dictation',
  completedByFeatureInteractions: ['voice-dictation']
}
```

Then make sure the feature records its interaction at the meaningful product moment. For example, voice dictation records only after a session reaches `listening`, not when the settings pane opens.

## Adding A Tour

Tours still use `contextualToursSeenIds` to avoid repeating the same tour. If opening or using the toured surface should also suppress future education for that feature, call `recordFeatureInteraction(featureId)` from the surface's meaningful interaction point.

For contextual tours in this branch, `useContextualTour(...)` records the matching interaction once the surface is enabled and persisted UI is ready. Surface-specific gates decide what "enabled" means; for example, the browser tour waits for a non-blank local browser page.

## Test Profiles

Completed-onboarding E2E profiles should preseed both education exposure and feature interaction state. That keeps first-run education from covering unrelated UI under test while preserving production behavior for real profiles.

Profiles that model existing users should also set `contextualToursAutoEligible: false`; profiles that explicitly exercise contextual tours can set it to `true`.
