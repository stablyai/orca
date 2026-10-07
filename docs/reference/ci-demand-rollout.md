# CI demand rollout

This implements the September 28 runner-demand analysis. The baseline inventory
covered September 27 04:00–September 28 04:00 UTC: 4,028 workflow runs, with
463 stratified job samples. Estimated occupancy was 1,081 runner-hours, dominated
by PR unit shards (414 hours) and Bun qualification (262 hours, since replaced by the
pinned-Node headless lanes). These are
sampled sums of job durations across different runner pools, not billing totals
or a guaranteed forecast of savings.

## What runs now

| Work                                   | Ordinary draft update                      | Ready PR / final checks                                                                            | Main reference                                                                      |
| -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Static analysis and types              | Immediately                                | Immediately                                                                                        | Existing workflows                                                                  |
| Unit suite                             | Full, with shadow selection evidence       | Full                                                                                               | Existing daily Node 24/26 x86 suite                                                 |
| Packages                               | After successful static analysis and types | Same                                                                                               | Existing release workflows                                                          |
| Headless Node persistence              | Deferred until ready                       | Linux x64 for ordinary runtime changes; explicit platform families or all six for sensitive inputs | All six platforms for relevant main pushes; full nightly qualification at 11:30 UTC |
| Headless Node glibc/musl qualification | Deferred until ready                       | Linux-specific or full qualification, after persistence succeeds                                   | Both architectures for relevant main pushes and nightly qualification               |
| E2E                                    | Existing targeted routing                  | Existing targeted routing                                                                          | One complete run at 17:00 UTC                                                       |

Headless draft updates carry no verdict; readiness starts the checks. Relevant
ready PRs retain Linux x64 smoke coverage. Explicit Windows or macOS paths add both
architectures in that family, while Linux paths add Linux ARM and the glibc/musl
lanes. Root/toolchain inputs, native build inputs, shared execution/storage paths,
SSH, providers and relay changes retain every platform. Missing or incomplete
change evidence and failed import analysis also retain full qualification.
Unrelated changes skip through the dependency classifier. Relevant main pushes
qualify all six platforms and both Linux compatibility architectures; detection
uses the whole push before qualification can supersede an older relevant run.

The detector checks known build inputs with the pinned Node toolchain first.
Other paths install dependencies for import analysis; an uncertain result never
skips qualification. This changes setup cost, not the qualification policy.

Windows server prebuilds are cached separately by architecture and pinned build
inputs, including the runner image. Only successful qualification on main publishes
them. Consumers validate the payload and still run the pinned-Node load/spawn smoke;
a cache miss or invalid payload builds fresh. Nightly, manual and release builds
remain fresh. No native artifact is shared across platforms or ABIs.

Expensive PR jobs wait for static/type success. This reduces fan-out for failed
or rapidly superseded commits without sleeping on a runner. Successful isolated
PRs pay the extra stage latency. Existing per-PR cancellation remains in place.
Package assertions, native boundaries, SSH/folder coverage, cache warming and
slow-test assertions are retained.

The daemon running-work test imports the shared probe directly, with the daemon's
process inspector supplied as its callback. The renderer keeps its existing
adapter and forwarding tests. This removes a mocked renderer dependency from the
headless graph without changing the probe algorithm or skipping backend tests.
At validation, the graph fell from 6,018 inputs (1,070 renderer inputs) to 4,879
inputs (no renderer inputs), including nine added shared-probe cases. Renderer
adapter changes no longer qualify the headless matrix; shared probe and daemon
test changes still do. Future actual renderer imports remain discoverable.

## Unit selection rollout

PR planning runs alongside typechecking after their shared dependency setup; an
explicit join publishes its artifact before the unit matrix can start. Static
analysis's Node 24 install also prepares the native cache before matrix fan-out.
The daily compatibility workflow retains its separate planner and cache primer.

`ci-unit-plan.mjs` discovers the same include/exclude set as Vitest and follows
static imports, re-exports, literal dynamic imports, CommonJS requires and the
renderer aliases. Consumers of indirect filesystem/process inputs remain in the
candidate set, as do script/tool tests. Global configuration changes, deletions,
renames involving removed paths, unknown inputs and graph failures run the full
suite. A shard verifies the plan's source SHA and complete discovery list before
using it. Missing/stale artifacts fall back to full coverage, even if that means
running the suite on fewer shards.

The initial policy was **shadow**, with every shard retained and five concurrency
slots for a full run. The account is charged a slot per job rather than per core;
in the September baseline, eight 6.5-minute shards made this matrix 68% of daily
slot demand while the ARM pool queued 10.5 minutes at p95. The first local
inventory matched Vitest exactly (9,950 files at validation); representative source
changes retained roughly 88% of files because of indirect input readers.
That is evidence for conservative coverage, not evidence of the analysis's
hypothetical 50% unit-work reduction. Improvements to indirect dependency
modeling should be demonstrated against full results before expanding selection.

### Controlled full-PR sharding

Full PR unit runs now request ten four-worker ARM shards through the existing
planner. Daily Node 24/26 reference runs retain five shards per Node version, and
selected draft runs retain their five-shard cap. Coverage, isolation, setup files,
worker flags and the protected actual-Node runtime projects remain unchanged.

Set the repository Actions variable `ORCA_UNIT_FULL_SHARD_COUNT` to `5` to roll
back full PR runs. Remove the override or set it to `10` to restore ten. Only `5`
and `10` are valid; invalid values fail planning. If change/graph evidence is
unavailable, planning still retains every discovered file at the requested full
count. Confirm the actual matrix and complete selection evidence on a new run
when changing the variable; do not infer the effective count from the setting.

The ordinary [five-shard run](https://github.com/stablyai/orca/actions/runs/37657068640)
and [ten-shard run](https://github.com/stablyai/orca/actions/runs/37657071738) used
identical definition/source trees on pinned main `7d6d7ca6`. Both first attempts
passed all required jobs and ran 11,678 files exactly once, with identical module
counts, states and actual runtime routes: 112,615 passed cases, one expected
failure and 1,052 stock skips.

| Observed boundary or resource                     | Five shards | Ten shards |                   Change |
| ------------------------------------------------- | ----------: | ---------: | -----------------------: |
| Longest unit test step                            |        571s |       322s |         43.61% less time |
| Unit prerequisite release to last unit completion |        618s |       362s |         41.42% less time |
| Unit release to required verification             |        628s |       371s |         40.92% less time |
| PR creation to required verification              |        819s |       545s | 33.46% less time; 1.503× |
| Aggregate unit test-step time                     |      2,649s |     2,852s |               7.66% more |
| Aggregate held ARM runner time                    |      2,827s |     3,206s |              13.41% more |
| Aggregate setup before tests                      |        157s |       317s |             101.91% more |
| Aggregate dependency installation                 |         57s |       112s |              96.49% more |

Nominal peak unit worker slots increased from twenty to forty. The comparison was
one observational pair on different hosts and cache states; unit runners started
6–8 seconds after allocation. Four additional diagnostic ARM jobs started after
all fifteen comparison runners had been allocated. This is not a quiet-fleet,
representative queue-tail or historical twofold-speedup result. Stock artifacts
prove module counts/states/routes, not complete individual case identities.

This is a controlled latency rollout with a resource tradeoff. The representative
week-long capacity evaluation below remains pending; one successful pair does not
satisfy that fleet gate or erase the earlier oversharding concern. Monitor queue
and provisioning delays, PR-to-verification latency and aggregate ARM runner time
in equivalent traffic windows, including cancellations and planning/reference
costs. Use the five-shard rollback if queue delay erases the latency gain.
Temporary benchmark PRs #26271 and #26272 never merge.

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
`shadow` to roll back immediately. Selected runs use one to five timing-balanced
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
