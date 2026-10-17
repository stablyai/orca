# Agent attention and change review

Status: product proposal, not an implemented feature or a test report.

## Existing behavior and reproducible recipes

Orca already supports scheduled prompts in existing workspaces, session reuse,
native completion notifications, terminal-bell notifications and configurable
focus suppression. The reusable recipes are:

- [Repository updates](../automation-recipes/repository-updates.md)
- [Pull request failures](../automation-recipes/pull-request-failures.md)

They replace machine-specific paths, workspace IDs and repository names with
explicit user-selected targets. They do not export local accounts, credentials,
runtime IDs or notification preferences. Creating or enabling an automation is
an explicit user action, not an application startup side effect.

## Phase 1: actionable notifications without repetition

Prioritize a request for a decision, a failed agent turn, a failed review check,
work ready for review, conflicting agent edits, and a failed scheduled run.

Each alert should identify the project and task, state the problem in one short
sentence and open the exact question, failed check, run or diff. Distinguish
failure from completion; an agent becoming idle is not proof the task succeeded.

Track incidents by execution host, workspace, subject and event identity. Notify
once, notify again on a material change, and report recovery once. Keep a durable
inbox for pending incidents. Reuse the existing status store and delivery service;
do not infer remote process death from lost connectivity. A scheduled precheck
with no findings must not create a success notification.

Validate event ownership, stale-result rejection, notification permission,
click destinations, privacy filtering, duplicate suppression, recovery and
localized copy. Cover disconnected hosts and mixed client/server versions.

## Phase 2: readable changes

Reuse existing diff word wrap, font settings, inline/side-by-side views and
unchanged-region controls. Offer a reading preset using established design-system
tokens: comfortable type and line spacing, softer full-line backgrounds and
stronger highlights on changed words. Retain added/deleted markers and accessible
contrast; color alone must not carry meaning.

Validate long code lines, narrow windows, deleted lines, large diffs, keyboard
navigation and both themes in background-rendered Electron screenshots.

## Phase 3: explain and review incremental agent work

Above the diff, show a short account of what changed, why it matters and what
was actually verified. Link each claim to the relevant hunk or verification
record. Show missing checks explicitly; never turn agent prose into proof.

Example: "Operator handoffs stay open until an operator replies. Previously they
could close after inactivity. Automated checks passed; manual review is pending."

Add "Changes since my last review" based on a retained review snapshot, so a user
can inspect the agent's latest correction without rereading the full branch.
Invalidate summaries when the underlying diff changes. Attribute edits to an
agent only when ownership is recorded, and keep user edits visible.

Validate summary provenance, exact diff versions, ownership, concurrent edits,
snapshot retention and recovery. Render explanations in the user's language.

## Evidence boundaries

Local manual runs produced "no updates" and "no failed checks" results. The
repository monitor preserved pending local edits. Native notifications were
enabled, focus suppression was disabled, and the user confirmed seeing the
settings test notification. This validates delivery on that machine; it does
not prove failed-PR alerts, incident deduplication or the proposed review UI.
