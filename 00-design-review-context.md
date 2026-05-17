# Design Review Context

## Document Info
- Path: docs/persist-tree-view-source-control.md
- Type: Technical Spec
- Review started: 2026-05-17T18:20:49Z

## Design Direction
- Direction confirmed: confirmed
- Chosen approach: Persist `sourceControlViewMode` as a per-user `GlobalSettings` field, defaulting to `list`, and wire the Source Control toolbar toggle through the existing settings store.
- Alternatives considered: Keep component-local state only (rejected because it does not persist); persist in workspace UI state (rejected because the request is per-user, not per-workspace); add a settings-pane control (deferred because the toolbar is where the preference is expressed today).
- Key UX decisions: Existing users keep list view by default; toolbar remains the only control; tree directory expansion remains session-local because it is repo-shape-specific.

## Iteration State
Current iteration: 2
Last completed phase: Verification review
Issues addressed this iteration: async toggle race; hydration fallback write risk; invalid persisted value handling; missing race/hydration tests

## Addressed Issues (Do Not Re-report)
<!-- Issues that were fixed in the design doc. Reviewers should not re-report these. -->
<!-- Format: [iteration] | [severity] | [category] | [issue summary] | [how addressed] -->

Iteration 1 | P1 | Concurrency | Rapid toggles can compute from stale rendered mode while settings writes are async | Made optimistic last-intent-wins state part of the baseline design with write sequencing and reconciliation rules.

## Skipped Issues (Accepted Risks)
<!-- Issues reviewed but deemed acceptable for this context. Do not re-report. -->
<!-- Format: [iteration] | [severity] | [category] | [reason skipped] | [issue summary] -->

Iteration 1 | P2 | UX | Initial `settings === null` list fallback can flicker or be persisted over saved tree preference | Addressed by disabling toggle before hydration and specifying fallback display only.
Iteration 1 | P2 | Invalidation | Corrupt persisted values were not normalized at runtime | Addressed with a component-boundary normalization helper returning `list` for invalid values.
Iteration 1 | P2 | Tests | Test plan missed async race and hydration transitions | Addressed with targeted unit test requirements.

## Invalidated Findings (Do Not Re-report)
<!-- Findings that were challenged and determined to be false positives or noise. -->
<!-- Format: [iteration] | [original severity] | [finding summary] | [reason invalidated] -->

[Initially empty - populated after each validation phase]

## Findings History
<!-- Running log of findings across iterations for convergence tracking -->

### Iteration 1
- P0: 0 | P1: 1 | P2: 3 | P3: 0
- Addressed: 4 | Skipped: 0
- Key changes: Added optimistic last-intent-wins write sequencing, hydration guard behavior, invalid value normalization, and targeted race/hydration test coverage.

### Iteration 2
- P0: 0 | P1: 0 | P2: 0 | P3: 0
- Addressed: 0 | Skipped: 0
- Key changes: Verification review reported no remaining P0/P1 findings.
