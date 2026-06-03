# Durable Docs

Keep this folder for versioned reference docs that are meant to survive past a single design or implementation pass.

## What Goes Here

- Stable reference material.
- Public-facing docs that are not part of the root README.
- Docs that other checked-in files link to.
- Telemetry availability notes that dashboard authors need after the original design or implementation branch is gone. See [Telemetry Availability](./telemetry-availability.md).
- Feature education state, interaction tracking, and retention analytics notes that define how contextual tours are persisted and measured. See [Feature Education State](./feature-education-state.md), [Feature Discovery Interaction Tracking](./feature-discovery-interaction-tracking.md), and [Feature Education Retention Analytics](./feature-education-retention-analytics.md).
- New-user parallel work telemetry notes that define how the parallel-work tour and setup guide should be measured against retention. See [New User Parallel Work Telemetry](./new-user-parallel-work-telemetry.md).

## What Stays Out

Ephemeral design notes, implementation sketches, and planning docs should stay as local Markdown files under `docs/`. They are ignored by default so they do not get checked in accidentally.
