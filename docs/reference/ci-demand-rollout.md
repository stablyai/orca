# CI demand rollout

This implements the September 28 runner-demand analysis. The baseline inventory
covered September 27 04:00–September 28 04:00 UTC: 4,028 workflow runs, with
463 stratified job samples. Estimated occupancy was 1,081 runner-hours, dominated
by PR unit shards (414 hours) and Bun qualification (262 hours). These are
sampled sums of job durations across different runner pools, not billing totals
or a guaranteed forecast of savings.

## What runs now

| Work                         | Ordinary draft update                                                          | Ready PR / final checks                       | Main reference                          |
| ---------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------- |
| Static analysis and types    | Immediately                                                                    | Immediately                                   | Existing workflows                      |
| Unit suite                   | Full, with shadow selection evidence                                           | Full                                          | Existing daily Node 24/26 x86 suite     |
| Packages                     | After successful static analysis and types                                     | Same                                          | Existing release workflows              |
| Bun persistence              | Linux x64 for ordinary runtime changes; all six platforms for sensitive inputs | All six platforms when Bun inputs changed     | Full nightly qualification at 11:30 UTC |
| Bun glibc/musl qualification | Sensitive inputs only, after persistence succeeds                              | Both architectures after persistence succeeds | Both architectures                      |
| E2E                          | Existing targeted routing                                                      | Existing targeted routing                     | One complete run at 17:00 UTC           |

Bun-sensitive inputs include root/toolchain files, configuration, native code,
resources, platform-specific paths, persistence, SQLite, orcad, providers,
daemon, SSH, relay, and child-process code. Dependency discovery failure, a
missing event or an incomplete diff retains full qualification. An unrelated
change still skips Bun through the existing dependency classifier. No native
artifact is shared across platforms or ABIs. The routine draft reduction is an
explicit coverage-placement change; it does not assert identical per-update
coverage. Every non-draft synchronize event and the ready-for-review event
restores full qualification.

Expensive PR jobs wait for static/type success. This reduces fan-out for failed
or rapidly superseded commits without sleeping on a runner. Successful isolated
PRs pay the extra stage latency. Existing per-PR cancellation remains in place.
Package assertions, native boundaries, SSH/folder coverage, cache warming and
slow-test assertions are retained.

## Unit selection rollout

`ci-unit-plan.mjs` discovers the same include/exclude set as Vitest and follows
static imports, re-exports, literal dynamic imports, CommonJS requires and the
renderer aliases. Consumers of indirect filesystem/process inputs remain in the
candidate set, as do script/tool tests. Global configuration changes, deletions,
renames involving removed paths, unknown inputs and graph failures run the full
suite. A shard verifies the plan's source SHA and complete discovery list before
using it. Missing/stale artifacts fall back to full coverage, even if that means
running the suite on fewer shards.

The initial policy is **shadow**, with all eight shards retained. The first
local inventory matched Vitest exactly (9,950 files at validation); representative
source changes retained roughly 88% of files because of indirect input readers.
That is evidence for conservative coverage, not evidence of the analysis's
hypothetical 50% unit-work reduction. Improvements to indirect dependency
modeling should be demonstrated against full results before expanding selection.

Every shard uploads `unit-selection.json`, `unit-timings.json` (including module
outcomes), and its assignment. The evidence job combines these into
`unit-selection-review-attempt-N/selection-review.json`, reporting:

- Whether every discovered file appeared once across a complete reference run.
- Failures outside the candidate set, including failures in otherwise red runs.
- Measured worker time that selection would omit; worker times overlap and are
  not runner occupancy or a prediction of wall-clock savings.

Missing/duplicate shards, stale plans, interrupted runs and unhandled errors do
not count as complete references. Diagnostic upload/report failures do not make
tests pass and do not independently fail successful tests.

After representative complete shadow runs show no missed failures, set repository
variable `ORCA_UNIT_SELECTION_MODE=selected` to enable selection **only for draft
PRs**. Keep full ready-PR checks and the daily compatibility suite. Inspect at
least a week's evidence across renderer, main, shared, SSH and fixture changes
before promotion, including red runs rather than only successful examples.
Unknown variable values retain shadow mode. Unset the variable or set it to
`shadow` to roll back immediately. Selected runs use one to eight timing-balanced
shards based on retained work.

Ready-for-review result reuse includes `unit full` in its source/workflow
identity. A green selected draft cannot satisfy the final full check, even if
the repository variable changes between runs. An already successful _full_
identical-source check can still be reused.

To inspect downloaded shard artifacts locally:

```sh
node config/scripts/ci-unit-selection-review.mjs ARTIFACT_DIRECTORY
```

## Review automation

Pullfrog recognizes the existing `Review #N [id]` and
`Review new commits on #N [id]` dispatch names. Explicit dispatchers may provide
`pull_request_number` and `head_sha`. Explicit PR identities share concurrency at the workflow boundary. Legacy review
names use a bounded lookup of the latest 100 dispatches and cancel only lower
run IDs for the same PR; a delayed older scope cannot cancel a newer review.
Unrecognized tasks are never grouped. The scope job alone has Actions write
permission for ordered cancellation. Closed PRs and explicitly stale heads
are skipped. A second head check prevents starting an agent after its queued
head has changed. Unrecognized agent tasks remain independent; lookup failures
also retain an independent task rather than cancelling unrelated work.

This does not introduce a fixed debounce interval or remove final reviews.
Dispatchers should supply `head_sha` for reliable stale-at-dispatch detection;
legacy names identify a PR but do not prove which head the prompt describes.

## E2E signal

The daily reference still executes all shards and keeps original verdicts. Each
shard uploads Playwright JSON and publishes expected, skipped, unexpected, flaky
and startup-error counts with the failing test names/messages. Targeted PR and
manual coverage remain available. This change does not fix the historically
red tests or pretend they pass.

`config/e2e-failure-tracking.json` can separate an evidenced repeated failure
from new failures in the summary. Each entry must have exact `file`, full
`title`, `project`, a nonempty stable `message` substring, an `@owner`, a linked
repository `issue`, and an ISO `expires` review date. Expired/malformed entries
are ignored and reported; changed error signatures appear as untracked. Entries
never skip a test or change its exit status. The initial list is empty because
the analysis established red workflows but did not establish owners and
reproductions for individual failures. Do not blanket-baseline an entire red run.

## Capacity measurements and acceptance

`CI runner demand` runs daily at 04:23 UTC and can be dispatched manually. It
reads the previous 24 complete hours in hourly pages, samples up to six runs per
workflow/outcome stratum, and fetches job pages with bounded concurrency. An
hour exceeding the API's 1,000-result search cap fails visibly. The report and
raw evidence are retained for 30 days. No extra runner pool is provisioned.

The report measures the full job durations of runs **created** in the window,
not occupancy clipped to the window: earlier runs that overlap it are excluded,
and completed sampled jobs may finish after it. This matches the baseline
cohort method. Workflow IDs keep ref-qualified paths in one sampling stratum.

The report shows weighted runner-hours and cancelled-run hours per workflow,
runner-minutes per completed PR _run_, and weighted queue/provisioning p95 per
runner label. It counts latest attempts only, excludes incomplete jobs, and
retains zero-job observations. It does not measure other repositories competing
for organization capacity. Compare equivalent traffic windows, not raw totals
alone. The collector needs only `contents: read` and `actions: read`.

After a week, compare runner-minutes per PR run, cancellation occupancy and
queue p95 in each affected pool. Count newly added planning/reference overhead.
A 25–35% overall reduction remains an experiment target, not an achieved result;
selection, coalescing and matrix reductions overlap and cannot simply be added.
