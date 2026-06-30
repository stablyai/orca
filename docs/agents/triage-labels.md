# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an implementation agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role, use the corresponding label string from this table.

If the GitHub repository already uses different labels, update the right-hand column before running triage workflows.

## Pipeline PRD labels

The Orca Pipeline feature adds one extra label convention on top of the five Matt skill triage roles.

- Default Pipeline PRD label: `pipeline:prd-<PRD issue number>`, for example `pipeline:prd-2`.
- Add this label to every task-slice issue that belongs to that PRD and should be runnable by Pipeline.
- Keep the `ready-for-agent` label as the readiness gate; the Pipeline PRD label only groups tasks into one PRD work set.
- Pipeline execution does not remove `ready-for-agent` and does not add `in-progress` or `claimed`; those labels are not part of the Pipeline contract.
- Each PRD has exactly one Pipeline PRD label.
- A task-slice issue is Pipeline-runnable only while its parent PRD issue is open.

Add the Pipeline PRD label during `/e2e-slices` / `to-issues` when task-slice issues are created. If an existing task-slice issue is missing the label, `/e2e-triage` must add it before treating the issue as Pipeline-runnable. Pipeline runtime validates the label but does not infer or add labels at launch time.
