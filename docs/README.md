# Orca Docs

Keep this folder focused on durable design notes, implementation plans, and
feature references that are still useful after the original PR or release work
lands.

## Current References

- `focus-follows-mouse-design.md`
  - Rationale and edge cases for focus-follows-mouse behavior.
- `focus-follows-mouse-plan.md`
  - Rollout checklist and validation notes for focus-follows-mouse.
- `split-groups-rollout-pr*.md`
  - Incremental split-groups rollout plans.
- `file-explorer-external-drop.md`
  - Design notes for importing files from OS drag-and-drop.
- `performance-audit.md` and `performance-implementation-plan.md`
  - Performance findings and planned remediation steps.
- Other feature-specific markdown files in this folder remain useful when they
  match the area you are changing.

## Why The Folder Changes

Earlier design and implementation work produced several planning and evaluation docs.
Those were useful while the feature was taking shape, but they were intentionally removed
once the implementation converged so future readers are not forced to choose between
multiple overlapping sources of truth.
