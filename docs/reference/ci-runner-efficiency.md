# CI efficiency and runner capacity

The [September 28 demand rollout](ci-demand-rollout.md) documents staged checks,
unit-selection evidence, headless runtime qualification, review cancellation and daily occupancy reports.

## October 1 PR concurrency follow-up

### Where the next gains are

The [September 30 demand report](https://github.com/stablyai/orca/actions/runs/36816009362)
samples 282 of 4,194 runs across workflow/conclusion strata. It estimates full job
duration for runs created in the reporting window, rather than occupancy clipped
to that window. PR CI accounts for about 537 runner-hours, including about 321
hours of unit shards, 73 hours of E2E, 41 hours of Windows packaging, 35 hours of
Linux packaging, 18 hours of static analysis, and 11 hours of typechecking. These
are weighted estimates, not exact billing totals. Unassigned and incomplete jobs
are excluded. The report predates the merged planning/setup change below.

The [full reference run](https://github.com/stablyai/orca/actions/runs/36841821670)
ran 10,310 files exactly once. Across its five shards Vitest reports about 5,063
worker-seconds importing modules, 2,838 running tests, 685 transforming source,
267 setting up tests, and 390 preparing environments. Workers overlap, so these
figures cannot be added to predict job elapsed time. They identify repeated
imports and real-time test waits as larger targets than line-count reporting,
which uses about 1.1 runner-hours in the same demand sample.

Parallel steps share the job's CPU and memory. Their
[background/wait support](https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/)
saves repeated runner setup when independent checks fit together, but does not
increase machine resources or the account's concurrent-job allowance. Cheap
preflight checks still gate expensive unit and package jobs.

Organization metadata reported the Team plan on October 1. GitHub documents
[60 standard concurrent jobs by default](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners)
and allows support requests for increases. The effective configured allowance
was not exposed by the API. A seven-second, repository-only sample at 10:48 UTC
found 32 queued jobs and 70 assigned job records marked in progress, including
one Blacksmith label. Those non-atomic records, runner turnover, other repositories
and provider labels cannot establish the actual allowance or simultaneous usage.
These changes reduce demand; they do not change account settings. If queues
remain, ask GitHub Support to confirm the effective organization limit before
choosing a larger allowance or paid runners.

The [follow-up PR](https://github.com/stablyai/orca/pull/24355) measures virtual
readiness deadlines in captured-transcript tests, E2E allocations with no general
consumer, renderer projection, native setup, Docker fixtures, and Windows store
restoration. Alternating hosted comparisons check output parity. Completed
benchmark workflows and drivers are removed; their trial commits retain the
exact reproduction code.

A [three-pair hosted transcript comparison](https://github.com/stablyai/orca/actions/runs/36849458799)
on one four-worker ARM runner measured baseline invocations at 127.001 / 114.307 /
114.265 seconds, versus 28.903 / 28.663 / 28.455 seconds with virtual readiness
deadlines. Median elapsed time for these five files fell about 75%. All 259
original named tests passed in every baseline and candidate, and candidates
also passed three repaint checks. Summed test-body time fell from a median 325.85
to 31.80 worker-seconds. This comparison includes Vitest startup/import work but
excludes checkout, dependency setup, and queues; it is not a measured percentage
improvement in the full unit matrix. Real emulator setup and drains remain real,
and the same captured bytes, readiness/refusal deadlines, and assertions run.

The same hosted trial passed three forced Electron native rebuilds while the
external node-gyp path pointed to a nonexistent file. A separate fresh consumer
then restored the native cache, required a real hit, and passed the existing
Electron binary probe. The Linux Node-runtime workaround remains intact.

For a network-only E2E selection in that trial, both dedicated network jobs
passed. The previous allocations consumed 87 seconds for the Electron build,
34 for the native primer, and 67 for a general job whose log confirmed that
every selected spec belonged to a dedicated lane. The candidate skipped those
three jobs before runner allocation, avoiding 188 runner-seconds in this case.
This single-case measurement excludes queues and does not predict savings for
mixed selections; the existing dedicated SSH, IME, and ordinary E2E routes remain.

A [controlled cancellation trial](https://github.com/stablyai/orca/actions/runs/36853246785)
verified both condition outcomes. After intentional cancellation, `always()`
started another 60-second follow-up, while `!cancelled()` skipped it. Cleanup
and artifact uploads succeeded in both treatments. A separate deliberately
failed test still ran its later `!cancelled()` test and cleanup. The 60 seconds
are synthetic condition evidence, not a measurement of a real SSH test's cost.
Completed comparison workflows are removed after recording their evidence;
the exact drivers and workflow remain reproducible at the trial's source commit.

The [first full PR validation](https://github.com/stablyai/orca/actions/runs/36849458648)
passed all five unit shards and both Linux/Windows package checks. Its reports
contain 10,326 unique files, each once, with zero unhandled errors. Full shard
job durations ranged from 544 to 581 seconds. They ran a different merged source
on different allocations from the earlier reference, so comparing their totals
does not establish an end-to-end speedup. The alternating transcript comparison
above is the controlled timing evidence.

The [updated full PR validation](https://github.com/stablyai/orca/actions/runs/36855833565)
passed all required gates and both package checks. All 10,335 discovered files
appear once across five passing timing reports, with zero unhandled errors;
122 modules have the existing expected skipped status. Named merge-tree discovery
and saved assignment replay match both successful validation runs. The latest
unit jobs took 520–558 seconds. Refreshing weights with that same measurement set
would reduce the largest projected load from 1,756.706 to 1,708.187 worker-seconds
(2.76%), while retaining the same 8,540.831 total. Applying the earlier successful
run's proposed weights to the latest measurements improves the maximum only
1.54% and the median 0.68%. These small, variable projections do not establish
an elapsed-time gain, so the existing weights remain.

A [three-pair Windows store comparison](https://github.com/stablyai/orca/actions/runs/36853246494)
used fresh dependency trees, stores and pnpm metadata before each treatment. The
middle pair reversed order. Cached totals include archive restoration and both
unchanged frozen installs; the mobile install ran every existing postinstall
generator. Setup/reset time and runner queues are excluded.

| Pair | First treatment | Cached total | Registry total | Registry saving |
| ---- | --------------- | ------------ | -------------- | --------------- |
| 1    | Cached          | 71.092s      | 37.500s        | 33.592s         |
| 2    | Registry        | 73.556s      | 39.935s        | 33.621s         |
| 3    | Cached          | 75.660s      | 37.001s        | 38.659s         |

Treatment medians were 73.556s cached and 37.500s registry; median paired saving
was 33.621s. Cache restore and step overhead alone cost a median 27.955s. Policy
and all six generated-output digests matched across all six treatments. Windows
x64 PR jobs using the mixed root/mobile key now skip its download-store restore;
PRs already skip store saves. Root-only Windows stores, Windows ARM64/x86, other
operating systems, non-PR writers, native/Electron caches and frozen-install policy retain their existing
behavior. The trial covers this mixed install on Windows 2022, not every Windows
dependency key or a whole PR's elapsed time.

A [three-pair daemon fixture comparison](https://github.com/stablyai/orca/actions/runs/36853246776)
reset Docker build caches and the fixture/base image before every treatment.
Warm totals include the existing action's archive restore/load and the unchanged
daemon descendant oracle; reset time and runner queues are excluded. The middle
pair again reversed order.

| Pair | First treatment | Cold total | Warm total | Warm saving |
| ---- | --------------- | ---------- | ---------- | ----------- |
| 1    | Cold            | 28.984s    | 20.673s    | 8.311s      |
| 2    | Warm            | 21.798s    | 28.953s    | -7.155s     |
| 3    | Cold            | 28.964s    | 17.614s    | 11.350s     |

Treatment medians were 28.964s cold and 20.673s warm; median paired saving was
8.311s. Oracle medians fell from 28.886s to 4.907s, while archive restore/load
cost 13.025–24.024s (15.766s median) for a 714,643,456-byte archive. BuildKit
confirmed warm provisioning was cached and cold provisioning was not; every
treatment used the same immutable base image, reaped the descendant and kept
the canary alive. The PR keeps restoration in the background during root/mobile
installation. One serial pair was slower, so the roughly 24s oracle reduction
is not a guaranteed total runner saving. The drivers and exact workflows remain
available at source commit `9231d1be6c76ccc1d2fef741a4e68ae29735a5c8`.

A [three-pair AppImage compression comparison](https://github.com/stablyai/orca/actions/runs/36855833100)
packaged the same complete Linux x64 app with the pinned 1.0.3 toolset and
mksquashfs 4.6.1. Each timing includes the private app copy, electron-builder
and blockmap generation. Tool download, app compilation, extraction, parity
checks and queues are excluded; the middle pair reversed order.

| Pair | First treatment | Default zstd 15 | PR zstd 3 | Saving  |
| ---- | --------------- | --------------- | --------- | ------- |
| 1    | Default         | 22.580s         | 11.760s   | 10.820s |
| 2    | PR              | 22.612s         | 12.560s   | 10.052s |
| 3    | Default         | 22.512s         | 11.815s   | 10.697s |

Median packaging time fell from 22.580s to 11.815s (47.7%); median package size
grew from 213,873,601 to 237,570,611 bytes (11.1%). All six extracted manifests
matched every path, byte, mode and symlink target: 4,096 files and 601,194,650
file bytes. The runtime prefix matched the pinned runtime exactly, and stored
SquashFS options confirmed the actual level-3 override. All static checks passed;
the representative baseline and candidate each passed the unchanged headless
and CLI journeys, including all entrypoints and both shutdown signals. The
directory build passed the existing glibc floor checks on all 19 native binaries.

Only the PR Linux x64 AppImage child receives the private tool overlay. It resolves
the existing custom-tool override first, checks the pinned tool/version and zstd
configuration, and reuses the original runtime, validator and libraries. Cleanup
waits for every package worker even on failure. Release settings, Linux ARM,
Debian/RPM packaging and all native/package gates retain their existing behavior.
The isolated AppImage result does not establish the full three-format job's gain.

The same hosted comparison projected one already-built renderer three times per
treatment, again alternating order. Baseline times were 8.079 / 8.219 / 8.129s;
candidate times were 2.568 / 2.477 / 2.403s. Median projection fell from 8.129s to
2.477s (69.5%, 5.653s saved). All six web snapshots matched all 1,137 files and
51,957,014 bytes, and the renderer input remained unchanged after every run.
These timings include the projector process but exclude renderer compilation,
checkout, setup and queues. The drivers and workflow remain available at source
commit `8ba5c9bf9f734d585f5e89945519aef4f607face`.

Two local cache screens do not justify enabling Node's compile cache. A 96-file
screen with an explicit worker flush produced a small, noisy difference. A larger
256-file screen retained all 2,088 tests: baseline elapsed times were
54.630 / 55.105 / 55.171 seconds, fresh caches 53.719 / 54.577, and a warm cache
53.732. The roughly 1.7% median difference is too small to justify cache transfer
and another test hook without stronger hosted evidence.

Vitest 4.1.11's experimental filesystem module cache is more promising locally,
but raw reuse is unsafe. A 96-file screen fell from about 8.4 to 5.9 seconds with
a warm cache, while a cold cache cost about 3%. Negative controls then reproduced
false passes after adding a preferred import extension, retargeting a symlink,
changing package exports, or changing transform inputs. Cache-disabled controls
failed correctly. A cache key must cover resolution and transform inputs as well
as file contents before any production trial; source hashes alone do not suffice.

Affected-test selection remains in shadow mode. Its first merge was September
28, so October 1 cannot satisfy the documented week of evidence. Seven sampled
complete reference reports included one red run, but only two evaluated a smaller
candidate set; each omitted about 177–179 worker-seconds out of 8,073–8,392. Five
full fallbacks are not selection-validation evidence, and two other sampled red
runs had no review artifact. These samples support keeping the conservative
policy, rather than claiming that omitting roughly 12% of files would omit the
same fraction of work.

### Shared planning and typechecking

PR planning now shares checkout and dependency setup with typechecking. Planning
runs in the background, with an explicit failure-propagating join before its
artifact is published. Static analysis remains on a separate runner. Its existing
native dependency install is pinned to Node 24 so it also fills the unit matrix's
native cache, replacing the separate conditional PR primer. Daily Node 24/26
reference planning and priming remain independent.

The planner also avoids constructing the import graph when global changes or
missing change evidence already require the full suite. This keeps the same
fallback reason, discovery list and execution coverage. Five PR unit shards,
static/type gates, package checks and the shadow-selection policy are retained.

A [three-sample hosted comparison](https://github.com/stablyai/orca/actions/runs/36833782900)
measured standalone type jobs at 35 / 26 / 42 seconds and planning jobs at
36 / 25 / 24 seconds. Shared type/planning jobs took 38 / 37 / 27 seconds.
The sum of the separate job medians fell from 60 to 37 seconds. Using that estimate with
the 139-second median static job models about 12% less preflight occupancy.
This is not a measured reduction in total CI time or queue delay. All twelve
plans matched, and three deliberately fresh native-cache producers were reused
by three successful consumers with the real native dependency probe.

After updating to the current main branch, a
[six-pair alternating comparison](https://github.com/stablyai/orca/actions/runs/36840171700)
reset compiler state before every measurement. Direct compiler/planner command
time was 11.59 / 11.31 / 10.96 seconds sequentially versus
6.82 / 6.52 / 6.33 seconds together with restored state. With state deleted,
it was 67.36 / 67.05 / 61.75 versus 55.52 / 60.06 / 55.68 seconds.
All commands passed and plans matched within each comparison. These command
timings exclude setup and queues; compiler variation contributes to the cold
difference. The retained arrangement showed no cold compiler penalty.

Combining static analysis too was rejected. An
[alternating same-runner comparison](https://github.com/stablyai/orca/actions/runs/36835091650)
saved runner occupancy, but cold compilation slowed from 61–64 to 83–89 seconds
under contention. The combined gate would finish roughly 40 seconds after the
separate static gate. An
[earlier-compiler trial](https://github.com/stablyai/orca/actions/runs/36837523594)
did not remove that penalty. Small localization scheduling changes also lacked
a repeatable gain. The temporary pilot workflows and benchmark tooling are
available in those runs' commits, rather than retained in normal PR CI.

Line-count reporting stays separate: it uses a small runner and trusted scripts
with PR write permissions. Sharing that job's credentials with PR-source checks
would provide little resource benefit. Reducing unit shards would trade saved
setup for a longer critical path; enabling selected tests requires the existing
week of representative shadow evidence.

## September 27 follow-up

### Shared E2E CLI output

E2E consumers previously compiled the CLI individually even though they downloaded
shared Electron, web, and relay output. The producer now compiles the CLI once,
in parallel with web projection after Electron has finished clearing `out/main`.
Consumers repair executable permissions and install their own dev launcher with
the same preparation script used by local CLI builds. Older refs without that
script retain their original per-consumer compilation.

An [eight-sample comparison](https://github.com/stablyai/orca/actions/runs/36307081200)
measured producer time increasing from 26.3–27.9s to 38.8–41.0s, while consumer
CLI compilation fell from 20.9–21.2s to 0.06–0.07s of direct preparation. All 5,519
output files matched byte-for-byte, and every sample passed the CLI help smoke.
A four-sample
[final implementation comparison](https://github.com/stablyai/orca/actions/runs/36307382635)
also passed parity and CLI smoke checks. Consumer compilation took 4.7 / 12.8s
versus 0.08 / 0.06s of preparation; producer time increased by 0.2 / 7.1s in
the paired trials. Across both runs this models roughly 1.1–4.7 aggregate runner
minutes saved across 14 consumers, before artifact transfer overhead. Runner
variation is substantial; this is not a measured workflow wall-time reduction.
Test coverage and deadlines stay intact.

[PR #23368](https://github.com/stablyai/orca/pull/23368) overlaps shell installation
with dependency setup, starts localization extraction before the orcad smoke,
and prepares mobile route snapshots while WebKit and the bundle are being built.
Its 27 checks passed without retries; seven existing conditional checks skipped.

Same-runner comparisons in both orders measured:

| Work                                | Before         | After          | Evidence                                                                           |
| ----------------------------------- | -------------- | -------------- | ---------------------------------------------------------------------------------- |
| Static block                        | 63.5 / 74.7s   | 38.9 / 55.6s   | [Full comparisons](https://github.com/stablyai/orca/actions/runs/36302208990)      |
| Shell job, downloads warmed equally | 76.8 / 70.3s   | 64.4 / 64.0s   | [Controlled shell runs](https://github.com/stablyai/orca/actions/runs/36302612626) |
| Mobile preparation                  | 19.8–21.6s     | 18.0–18.5s     | [Eight measurements](https://github.com/stablyai/orca/actions/runs/36302877583)    |
| Web projection and mobile build     | 17.2–17.3s     | 11.7–12.1s     | [Eight measurements](https://github.com/stablyai/orca/actions/runs/36302974324)    |
| Mobile verifier fixture suite       | 25.47 / 25.35s | 20.04 / 19.92s | [Four full-suite runs](https://github.com/stablyai/orca/actions/runs/36302692823)  |
| E2E build outputs                   | 28.6–30.4s     | 25.8–27.8s     | [Eight measurements](https://github.com/stablyai/orca/actions/runs/36304001325)    |

Full mobile-job timings were dominated by first-run apt installation and browser
test variation; the controlled preparation measurement is the scheduling evidence.
All 1,248 web/mobile output files matched byte-for-byte in the build comparison.
The fixture suite kept all 47 tests, isolated mutable copies, and the verifier's
two fresh builds. No deadline, isolation, or worker-count changes were needed.

E2E builds reuse the existing isolated main/preload/renderer build wrapper, now
forwarding `--mode e2e` to each target. All 2,640 output files matched byte-for-byte
in both execution orders, including the exposed test store and relay artifacts.
This saves a few build seconds; it does not speed up the E2E tests themselves.

The existing unit assignment was already balanced at about 919 historical
worker-seconds per shard; fresh x86 elapsed times still ranged from 254 to 433s.
Refreshing weights alone would encode runner variation rather than resolve it.
An [identical-source architecture pilot](https://github.com/stablyai/orca/actions/runs/36302250920)
ran shards 1 and 8 on both four-CPU hosted runners. Complete jobs improved from
449 to 404s and 461 to 384s on ARM, including setup; test and skip counts matched.
A [full ARM run](https://github.com/stablyai/orca/actions/runs/36302906752) then passed
all eight shards in 329–373 test seconds (365–412 job seconds). Uploaded reports
matched the same complete x86 assignment: 9,876 files, each exactly once, no
unhandled errors. These are elapsed samples excluding queue time, not a guarantee
that every ARM allocation is faster than every x86 allocation.

PR unit shards and their cache primer now use ARM; a main-branch warmer seeds
that architecture's existing native and pnpm cache keys. Native, package, and
relay gates continue on x86. The daily workflow retains complete x86 coverage on
both Node 24 and Node 26, including relay integration. Thus PR unit architecture
changes, while x86 unit coverage remains scheduled; this is an explicit coverage
placement tradeoff rather than a claim of identical per-PR host coverage.

PR validation exposed a WebRTC probe timeout inside a hidden renderer. Isolated
and four-concurrent probes passed on both architectures; the original cause is
unproven. The probe now uses Electron main for the same three-second observation
interval. A [fault-injection comparison](https://github.com/stablyai/orca/actions/runs/36304349257)
passed with renderer timers unavailable on both architectures, while the original
probe failed the negative control. Packet assertions and deadlines are unchanged.
A subsequent Windows run timed out in the installer's real CIM process query
after verifying restricted policy. Its unchanged probe now runs before the
concurrent native suite, removing that source of contention without relaxing
the twenty-second process deadline or dropping either PowerShell architecture.

Replacing Vitest deep comparisons with Node assertions in the status-store
oracle saved only about one local second in an initial trial. The change was
not retained: that evidence did not justify changing assertion semantics.

The combined root/mobile pnpm cache is now present on main and was restored in
the September 27 static comparison, so another warmer for that key is unnecessary.

A [fixture-warmer overlap trial](https://github.com/stablyai/orca/actions/runs/36303613587)
ran faster after initialization but exposed a first-use action-download race:
both background composites downloaded `actions/cache@v5` simultaneously, and
one briefly could not find `restore/action.yml`. The existing cache fallback
rebuilt the image and the job passed, but that recovery erased the speedup.
Keep the dedicated warmer serial. PR package restores remain safe from this
observed first-use race because their earlier top-level cache action is loaded
before the composites start; the workflow contract now preserves that ordering.

## Four follow-up changes

- Keep the readiness event, but reuse required checks only after an Actions API
  lookup proves that the same PR head, tested merge commit, and workflow commit
  already completed successfully. A changed base, missing proof, failed lookup,
  or still-running check falls back to the full checks. Advisory tests retain
  their normal readiness routing. The mobile and line-count workflows have no
  draft-dependent work, so they no longer run again when a draft becomes ready.
- Route the headless-runtime matrix using the actual headless build and selected tests'
  transitive imports, with conservative inclusion for dynamic workers, native
  inputs, fixtures, and toolchain changes. A graph failure runs the full matrix;
  manual dispatch still runs all ten platform jobs. The shared test selectors
  retain the same 85 files. Unrelated shard timings and mobile-test tooling can
  skip the matrix; shared shortcut definitions remain real runtime dependencies
  and still run it. Building the graph does not execute the imported modules.
- Restore pnpm stores on PRs using setup-node's existing key and store path,
  without publishing more PR-private copies. Non-PR setup-node caching and
  native/TypeScript caches keep their existing behavior. A missing main store
  still installs with the frozen lockfile. The mixed root/mobile store may miss
  repeatedly because the existing main warmer only seeds the root lockfile.
- Batch only the PowerShell quota-fixture reservations within each test, using
  the original generated scripts in fresh local scopes. Commands under test
  retain separate processes, real file identities, and existing race assertions.
  A traced local run confirms 44 PowerShell starts become 24, with all 21 cases
  passing. Alternating after/before/after elapsed times were 50.00/59.28/37.00
  seconds on a shared macOS arm64 host; that variance does not justify a precise
  percentage or hosted runner-time claim. Test budgets and worker counts are
  unchanged.

The reproducible pnpm-store comparison is
`ORCA_BACKGROUND_LAUNCH=1 node config/scripts/ci-pnpm-store-benchmark.mjs --samples=3`.
On macOS arm64 with BSD tar, three alternating fresh-store pairs eliminated a
median 332,746,995-byte archive per miss. Median install time was 17.33 seconds
before and 16.94 after; the removed archive step alone took 53.51 seconds.
Those local disk/CPU measurements exclude uploads and are not a prediction of
Linux or Windows hosted savings. Restore cost is common to both policies.

## September 26 verification

[PR #23053](https://github.com/stablyai/orca/pull/23053) was merged before its
latest full run finished. That run,
[36221874572](https://github.com/stablyai/orca/actions/runs/36221874572), ultimately
failed the mobile pending-frame precondition, just as the previous run had.
All eight unit shards passed, but the aggregate did not. An unchanged assertion
was not enough evidence to label the failure an unrelated flake.

Main subsequently received the deterministic frame hold in PR #22635. The real
terminal refit now queues a frame that the recorder holds until disposal has
finished, then releases surviving work against a remounted terminal. This
follow-up adds a negative control: cancellation is disabled only during disposal,
and the same recorder must report a document-owned callback after disposal.
The normal case retains its pending-work and zero-leak assertions. Both cases
passed five fresh headless Chromium runs locally; the complete terminal-render
file passed all 13 tests. Browser dependencies were required, so these were real
render checks rather than skipped bundles.

Unit model tests now import Monaco's editor API directly, preserving real models
and undo stacks without loading every language contribution. The registry bridge
requires only the editor and URI interfaces it actually uses. The full application
still imports its existing Monaco entry point; no production runtime behavior,
assertions, worker counts, timeouts or isolation settings changed.
A controlled local comparison (macOS arm64, Node 26.6.0, Vitest 4.1.11,
`--maxWorkers=1` only for this comparison) kept six files and all 32 tests.
Three warm original samples took 14.53/12.84/11.62 seconds; three editor-API
samples took 12.95/9.81/7.99 seconds, alternating back to the original imports
between measurements. Median elapsed time fell 12.84 to 9.81 seconds (23.6%);
median import time fell 10.73 to 7.94 seconds (26.0%). The initial cold original
sample, 20.29 seconds, is excluded. Shared-host variance remains; this is a
focused measurement, not a claim of a 23.6% improvement to the full unit suite.

The default-branch warmer
[36221917346](https://github.com/stablyai/orca/actions/runs/36221917346) successfully
published native modules and TypeScript state. Fresh PRs
[#23101](https://github.com/stablyai/orca/pull/23101) and
[#23104](https://github.com/stablyai/orca/pull/23104) restored both on their first
runs. Scope inventories showed neither PR had a private copy; the TypeScript
key existed only on main. Native restore took 0.45/0.54 seconds; TypeScript restore
took 0.38/1.31 seconds, with compiler steps of 8/39 seconds versus the warmer's
80-second cold compiler step. PR #23104 used the prefix fallback after its base
advanced, confirming reuse across commits as well as PRs.

The same warmer saved a 22.5 MB Git cache, but the exact key disappeared before
it was reused. Quota eviction is plausible, not proven: the usage API reported
17.48 GiB while a separate live 100-entry sample contained 15.15 GiB of pnpm
stores alone. These rapidly changing inventories are not atomic. The root-only
warmer does not seed the root-plus-mobile download-store key used by static
analysis, so both fresh PRs saved another roughly 350 MiB store. Controlling that
cache duplication is a remaining opportunity; hourly warming alone cannot
promise retention. Git's checksum-verified cold-build fallback remains required.

The unit scheduling baseline now comes from all eight successful Node 24 shards in
[run 36294142683](https://github.com/stablyai/orca/actions/runs/36294142683).
All 9,847 measurements match current discovery exactly once; the previous baseline
had 165 unmeasured files and one deleted path. Applying the same measurements to
both assignments reduces the largest projected load from 1,043.811 to 919.695
worker-seconds (11.9%). This is a scheduling projection, not an elapsed-time claim;
runner variation remains visible in the source run. See
[provenance and reproduction](../../config/scripts/ci-shard-timings.md).

## Recording compilation reuse

[Benchmark run 36295773765](https://github.com/stablyai/orca/actions/runs/36295773765)
compared the complete mobile suite on two hosted runners in opposite orders.
Compilation reuse reduced elapsed time from 439.002 to 138.308 seconds and from
560.926 to 200.751 seconds (64–68%). Each run preserved all 9,629 original test
verdicts and passed four additional cache regression tests. Compiled code is
bounded to 512 entries; exports, dependencies, and scenario state remain fresh.

Splitting family recordings across four files took 145.165 and 217.226 seconds,
5–8% slower than compilation reuse alone, so the original suite structure stays.
All 787 goldens were regenerated from the unchanged pinned product tree; only
the recorder digest changed, with identical recording bodies and value pools.

Desktop validation in [run 36295671576](https://github.com/stablyai/orca/actions/runs/36295671576)
passed all eight shards. The longest test step was 419 seconds versus 429 in the
source run; summed test time was 3,028 versus 3,031 seconds. Runner variation
prevents attributing that small elapsed-time difference solely to the weights.

## September 25 follow-up

The current queue is a bigger part of PR latency than setup. Successful full PR
[36212793136](https://github.com/stablyai/orca/actions/runs/36212793136) used
**74.6 aggregate runner-minutes**, including **55.5** for its eight unit shards.
Those jobs ran for 315–448 seconds but waited 229–1,076 seconds to start. The
three-second final `verify` job waited another 264 seconds. These are observed
job creation-to-start and start-to-completion intervals, not billing figures.

This follow-up keeps the existing tests, isolation, eight unit shards, platform
coverage, and release behavior:

- Make the reusable unit-test call and final aggregate respect cancellation.
  Their old `always()` conditions kept superseded work alive despite workflow
  cancellation. In [36215475069](https://github.com/stablyai/orca/actions/runs/36215475069),
  a newer push cancelled ordinary jobs while all eight unit shards remained
  queued and the replacement workflow remained pending. `!cancelled()` still
  evaluates after failed/skipped dependencies, without resisting cancellation.
  Two other superseded PR runs reproduced this: at 04:27 UTC on September 26,
  [36216165253](https://github.com/stablyai/orca/actions/runs/36216165253) and
  [36215543186](https://github.com/stablyai/orca/actions/runs/36215543186) still held
  11 runners, with two more obsolete jobs queued. They had consumed another
  71.3 runner-minutes after replacement pushes. After rechecking current PR heads
  and replacement runs, both obsolete runs were force-cancelled; their replacements
  left the blocked pending state.
- Combine root/README guards with change detection. A real sparse checkout kept
  all 29,487 index entries while materializing only 12 files (192 KB). This
  eliminates one runner allocation and checkout per PR. README link checks still
  see tracked targets outside the working tree and run on docs-only PRs.
- Use free `ubuntu-slim` containers for small guard/aggregate/API jobs; trial
  free `ubuntu-24.04-arm` for typechecking, which needs no native runtime.
  Both share the account's standard concurrency limit. Different labels do
  **not** grant extra concurrent jobs; hosted timings determine their value.
- Cancel superseded PR attempts in the Git termination, Pi owner, and Pi provider
  runtime workflows, retaining independent manual runs.
- Fetch only complete HEAD ancestry for cloud secret scanning. The old checkout
  fetched every branch and tag and took 55 seconds in
  [36214130174](https://github.com/stablyai/orca/actions/runs/36214130174).
  Real Git fixtures prove both merge parents and deleted historical contents
  still produce the identical scanned patches.
- Remove the cloud lockfile from the eight unit shards' download-cache key; the
  dedicated relay integration job still includes it. Record actual per-file
  environment, setup, import, and test durations for the existing shard planner.
  Shard 4 spent 535 worker-seconds importing and 357 executing tests; a uniform
  per-file import estimate misses that cost. See [timing refresh](../../config/scripts/ci-shard-timings.md).
- Seed Node 24 native modules, the pinned Git compatibility binary, and TypeScript
  state on the default branch, hourly
  and when dependency/toolchain inputs change. One ten-minute-bounded hosted job
  reuses existing cache keys and skips typechecking an already-cached commit.
  New PRs can restore default-branch caches, while caches saved by another PR
  are inaccessible. The audit found 80 entries totaling 10.67 GiB, including
  9.31 GiB of pnpm stores, but no main-branch Node 24 native or TypeScript state.
  Seven PRs held separate copies of the same pnpm key (2.36 GB combined).
  Git preparation now has one shared action with the unchanged cache key,
  checksum, and build command. In
  [36212101873](https://github.com/stablyai/orca/actions/runs/36212101873), a new PR
  spent 40 seconds compiling the same Git 2.25.5 binary; main-branch warming
  makes that cache available to new PRs too.

The hosted trial also removes repeated work in mobile bundle checks. The
builder keeps private snapshots of the default real output for read-only checks
(15 identical builds become two), and haptics checks reuse each route closure
(32 builds become eight). Determinism, custom inputs, malformed routes, stale
outputs, and tampered manifests retain independent builds. A mutation regression
proves Buffer/manifest consumers cannot change another assertion's fixture.
The grant census reuses parsed references for unchanged file contents, still
reads source every time, and has a real-file edit invalidation regression.
The first hosted mobile lane used 400 seconds for its 448 tests; the grant
census alone took 259 seconds. Locally, the same one-worker invocation of the
three changed files fell from 243.07 seconds (101 passing tests) to 49.49 seconds
(103 passing tests). Hosted run
[36217238462](https://github.com/stablyai/orca/actions/runs/36217238462) retained
the same 43 files and passed all 450 tests: the original 448 plus two regressions.
Its test step fell from 400.26 to 205.17 seconds, and the complete job fell from
498 to 298 seconds (40% less runner time). Builder, haptics, and grant-census file
times fell from 73.70/88.94/258.58 seconds to 29.24/32.98/22.58 seconds.
The later default-worker verification retained the same 450-test coverage, but
its unchanged terminal-render test failed twice on the pre-existing timing
assertion that a frame must be pending at disposal (`expected 0 to be greater
than 0`). Its other 449 tests passed; no mobile source or assertion was relaxed.

A four-worker experiment reduced aggregate unit job time from 3,386 to 3,133
seconds (7.5%), but the repeat run exceeded the palette matcher's existing
180ms performance budget at 235ms. The override was removed; retain Vitest's
default worker count, isolation, timeouts, retries, and coverage. The first trial
also found an outdated hook-order snapshot after main added three layout-persistence
hooks. That snapshot was refreshed only after comparing the exact old and merged
hook sequences. Final verification is linked from
[PR #23053](https://github.com/stablyai/orca/pull/23053). Failed timing reports
never replace the checked-in baseline.

No account settings, paid services, or runner entitlements changed. Standard
public-repository runners remain free. GitHub documents plan concurrency limits
of Free 20, Pro 40, Team 60, Enterprise 500, and permits support requests for
increases. The organization's actual entitlement was not exposed by the API.
See [runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and [concurrency limits](https://docs.github.com/en/actions/reference/limits).

Hosted observations from [PR run 36215718607](https://github.com/stablyai/orca/actions/runs/36215718607):

| Check                                     | Earlier sample |        Trial | Result               |
| ----------------------------------------- | -------------: | -----------: | -------------------- |
| Detection plus repository guards          |  54s, two jobs | 26s, one job | Passed               |
| Typecheck (whole job)                     |       109s x64 |      81s ARM | Passed               |
| Typecheck command, cold incremental state |        76s x64 |      51s ARM | Passed               |
| Cloud secret scan (whole job)             |            69s |          55s | Passed               |
| Cloud checkout/history fetch              |            55s |          40s | Identical scan scope |

The [warmup trial](https://github.com/stablyai/orca/actions/runs/36215718295)
passed in 54 seconds. Its x64 compiler restored the ARM job's incremental state
and rechecked the same source in eight seconds. Unit shard 3 subsequently
restored its pnpm/native cache keys successfully. Actual sharing across different
PRs requires the producer to land on the default branch; this trial validates
commands and key compatibility, not a completed default-branch rollout.
The follow-up warmup built the Git binary in 40 seconds; the PR Git check restored
that exact key and passed in 62 seconds overall. Its TypeScript refresh took
seven seconds after restoring earlier incremental state.

These are small observational samples from different revisions, not controlled
benchmarks. The cold typecheck log confirms an incremental-cache miss. Queue
changes must be separated from active duration and concurrent account traffic.
At the time of that trial, checked-in shard weights were unchanged; the September
26 refresh above now uses the complete successful unit reports.

## September 5 audit

Audit date: September 5, 2026. No paid capacity or provider configuration changed.

## Measurements and changes

Three recent successful PR runs used 54.6–64.9 aggregate runner minutes:
[33998366568](https://github.com/stablyai/orca/actions/runs/33998366568),
[33998220287](https://github.com/stablyai/orca/actions/runs/33998220287), and
[33998181502](https://github.com/stablyai/orca/actions/runs/33998181502).
These are sums of active job durations, excluding skipped jobs; they are not
billing minutes or queue time. This small sample is not a historical average.

- Consolidate E2E routing into the existing code-path detector. The removed
  detector occupied 20–22 seconds and required another runner allocation and
  full-history checkout per nondraft code PR. The same routing commands remain,
  including SSH and native IME selection; actual E2E results remain advisory.
  A routing-script error now fails the required code-path detector.
- Use gzip for PR-only Debian/RPM artifacts. The two sampled Linux packaging
  jobs took 8m10s and 8m19s overall; one spent 3m47s in electron-builder. Its
  default Debian/RPM compression is xz. PR artifacts are inspected on the same
  runner, so their download size offers no benefit. Keep all AppImage, Debian,
  RPM, payload, launcher, and shutdown checks. Release compression is unchanged.
  Hosted validation in [33999422341](https://github.com/stablyai/orca/actions/runs/33999422341)
  reduced the package-build step to 2m13s and the full Linux job to 6m17s, with
  all existing checks passing. This is a small observational sample.
- Cancel superseded Mobile Checks and Skill update round-trip PR runs. The
  skill matrix has 13 jobs. Preserve non-cancelling main/merge-group skill runs,
  with separate concurrency groups per event.
- Reuse the existing script-free root dependency action in Mobile Checks,
  including the pnpm cache keyed by both root and mobile lockfiles. The root
  install remains necessary because mobile types import root dependencies.

The repository already has eight unit shards, path-scoped platform checks,
native caches, one shared E2E build, PR cancellation, incremental TypeScript
caching, and changed-spec E2E routing. Increasing shards would increase setup
work and simultaneous runner demand. Do not adjust the count without comparing
critical-path time and aggregate job time on the same commit.

## Follow-up savings

- Move the hourly main/release freshness lookup to a five-minute Ubuntu
  preflight without a checkout. In unchanged run
  [33986205749](https://github.com/stablyai/orca/actions/runs/33986205749),
  Blacksmith macOS was occupied for 40 seconds, including a 30-second checkout,
  before skipping. The new job-level gate avoids that Mac allocation. Actual
  builds gain an Ubuntu scheduling hop; pin the Mac checkout and downstream
  Windows identity to the SHA that the preflight checked.
- Avoid global `npm install -g node-gyp` for validated Linux Node-runtime cache
  hits. Use the existing native-module load/provenance check before skipping;
  misses, broken addons, and Electron jobs still install the rebuild toolchain.
  The action file participates in cache keys, so this rollout creates fresh
  native caches once. No measured warm-cache seconds are claimed yet.

## Runner recommendations

The repository is **public**, verified using the GitHub API. Standard
GitHub-hosted Linux, Windows, and macOS runners have free compute minutes for
public repositories. Queue pressure and third-party provider allowances still
matter; artifact storage and larger runners have separate billing rules.
See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

1. Keep standard GitHub-hosted runners as the default. Ask GitHub Support for a
   higher concurrent-job limit before paying for more capacity. The documented
   standard limits depend on the account plan (Free: 20 total/5 macOS; Team:
   60/5; Enterprise: 500/50), and increases are subject to approval. The actual
   account entitlement was not verified. See [limits](https://docs.github.com/en/actions/reference/limits).
2. Reserve existing Blacksmith allowance for macOS if that is the priority.
   Blacksmith documents 3,000 free x64 2-vCPU-equivalent minutes per organization;
   a 6-vCPU Mac minute consumes 20 equivalents, or 150 actual Mac minutes if
   it uses the entire free pool. Cloud workflows also use Blacksmith Linux.
   Moving Linux to hosted GitHub saves shared allowance, but does not necessarily
   free Mac hardware capacity. Account-specific contracts and usage were not
   inspected. See [Blacksmith runners](https://docs.blacksmith.sh/blacksmith-runners/overview).
3. Treat Ubicloud as an optional small Linux overflow trial. Its documented
   $2.50 monthly credit buys 1,250 premium 2-vCPU minutes at $0.002/minute, or
   2,000 standard 2-vCPU minutes at $0.00125/minute. New accounts default to
   premium and require a credit card. No enforceable hard spending cap was
   verified, so changing runner labels cannot guarantee the no-spend constraint.
   One PR's roughly 55–65 runner minutes also makes clear how small this pool
   is relative to repository activity (hardware speeds differ).
   See [pricing](https://ubicloud.com/docs/about/pricing) and
   [setup](https://ubicloud.com/docs/github-actions-integration/quickstart).

### A bounded Ubicloud candidate

The Linux leg of `performance-contracts.yml` took 48 seconds in
[33994756657](https://github.com/stablyai/orca/actions/runs/33994756657).
Its daily schedule and 20-minute timeout make it a small candidate: 31 ordinary
scheduled attempts permit at most 620 job-runtime minutes, before runner
startup/cleanup billing. Actual timings on Ubicloud's 2-vCPU hardware still need
measurement; the GitHub timing is only a sizing reference.

If enabled later, route only the first attempt of the scheduled Linux job to
Ubicloud; keep PRs, manual dispatches, reruns, and macOS/Windows on GitHub. This
avoids spending the allowance on unpredictable PR volume. Check other account
usage and available credit before enabling; a workflow timeout is not an
account-wide billing cap. On September 5, the organization's GitHub App
installation list contained Blacksmith but no Ubicloud installation, so this
follow-up leaves runner selection on GitHub rather than queueing work against
an unprovisioned label.

## Machines that also run coding agents

Do not register the credentialed host directly as a public-PR runner. A PR can
execute arbitrary build/test code, and a persistent host lets it access local
credentials or affect subsequent jobs. Docker alone is not adequate isolation
when it exposes the host home, Docker socket, SSH agent, or office network.

A possible no-new-hardware experiment is a disposable VM per job, preferably on
a dedicated spare machine, with a just-in-time single-job runner, no shared
home/keychain/SSH agent or host mounts, restricted network access, and CPU/RAM
limits that leave room for coding agents. Destroy the VM after every job;
ephemeral runner registration by itself does not clean the machine. Start with
trusted branch/manual workloads and keep public fork PRs on hosted runners.
Provisioning and ongoing patching are real operational costs even when the
machine is already owned. See GitHub's
[self-hosted runner security guidance](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions).

## Release waits

The latest successful sampled Windows release used 13m59s of a 21m56s job in
signing wait/download steps. The same release held an Ubuntu job for 11m38s
polling the isolated Mac build. These are stronger occupancy opportunities than
small checkout savings, especially when approval takes hours.

[Windows signing without occupying a runner](windows-signing-runner-time.md)
describes a staged, same-run design, required protected environments, and
rehearsal criteria. No callback integration or protected Windows signing
environments currently exist. An environment-gated design adds a GitHub
approval after each SignPath approval and changes the current automatic inner
signing timeout fallback; those are explicit release-policy decisions, so this
PR leaves production signing behavior unchanged.

## Second audit and hosted trials

- Cloud Verify ran 100 times in a sampled 39-hour window (84 PR and 16 push
  runs). Move its four Ubuntu 22.04 jobs from Blacksmith to standard hosted
  Ubuntu 22.04, preserving Postgres, secret scanning, build, tests, and Terraform
  validation. Baseline [34001538145](https://github.com/stablyai/orca/actions/runs/34001538145)
  used 64/72/26/19 seconds for security/test/build/Terraform respectively.
  This conserves the shared provider allowance; hosted latency must be checked.
- Keep full tag history for the 13-job skill round-trip matrix, but fetch blobs
  lazily. Only two historical SKILL.md files are materialized. Baseline
  [33999994876](https://github.com/stablyai/orca/actions/runs/33999994876)
  spent 42–84 seconds per checkout, about 14 aggregate runner minutes. A hosted
  trial must verify historical blob fetches on all three operating systems.
- Use the existing Electron/native dependency cache for native IME CI. Keep
  both deterministic boundary and real IBus tests. Add pnpm store caching to
  terminal perf and release golden/evidence lanes; retain their raw installs
  because manually selected older refs may not contain the shared action.
- Disable ZIP recompression only for already-compressed NSIS installers sent
  to SignPath. Installer contents, release compression, and signing stay intact.
- Advance existing placement and startup deadlines with scoped fake timers in
  three renderer test files. All 34 tests pass in 62 ms of local test execution,
  versus 65.182 seconds in the sampled hosted baseline. Imports and transforms
  still dominate invocation time; this is not a claim of equal PR wall savings.

Eight unit shards already have balanced 260–296-second sample durations.
Reducing shards or removing test isolation lacks evidence of a net gain. Real
subprocess tests intentionally cover lifecycle behavior and retain real clocks.
The 14-way E2E split retains headroom after earlier 12-way timeouts. Lowering
coverage or schedule frequency is outside this efficiency pass. Cache complexity
for a seven-second docs install is unlikely to pay back. Release build reuse
across modes risks differing telemetry identities and native platform artifacts.

Terminal Perf's baseline [33955846492](https://github.com/stablyai/orca/actions/runs/33955846492)
failed waiting 30 seconds for workspaceSessionReady in its shared-page fixture,
before measuring terminal performance. Compare hosted trials against that known
failure rather than attributing it to dependency cache changes.

Hosted trials for the second audit:

- [Cloud Verify 34002295216](https://github.com/stablyai/orca/actions/runs/34002295216)
  passed all four jobs on standard hosted Ubuntu: security 57s, test 102s, build
  35s, Terraform 19s. The test lane is 30s slower than the Blacksmith sample;
  retain this modest latency tradeoff to conserve shared allowance.
- [Skill matrix 34002295221](https://github.com/stablyai/orca/actions/runs/34002295221)
  passed all 13 legs, including historical blob materialization. Checkout took
  18–20s on Linux, 39–45s on macOS, and 49–58s on Windows, versus the earlier
  42–84s range across platforms. These are observational samples.
- [Native IME 34002299594](https://github.com/stablyai/orca/actions/runs/34002299594)
  passed both deterministic and real IBus checks. Shared dependency setup took
  29s, versus 35s for the old install/toolchain steps in the sampled baseline.
- Native-IME-only source/spec changes no longer allocate the reusable E2E
  build, cache, and consumer jobs just to filter out the native spec. The
  separate native workflow still runs; SSH-only and mixed spec lists still
  allocate the reusable workflow. Routing contracts exercise these cases.
- [Hourly 34001816449](https://github.com/stablyai/orca/actions/runs/34001816449)
  exercised the new five-second preflight and successfully published macOS.
  The Windows follow-up failed in its unchanged input-vetting fetch because
  remote refs differ only by case on its case-insensitive filesystem. The
  requested SHA was correct; this does not validate an unchanged-main skip yet.

Moving the daily Mac freshness check has lower expected value than hourly:
only one potential idle allocation per day, and active development usually
requires that build. Defer another release-graph change until skip frequency
justifies it. The substantive remaining release occupancy opportunity is the
separately documented asynchronous signing policy decision.

## Persistent Vitest transform cache: rejected for now

A local 96-file import-heavy sample with Vitest 4.1.11 took 8.31/8.53 seconds
without its filesystem module cache, 8.63/8.69 seconds cold, and 5.91/5.91
seconds warm: about 30% faster warm. The cache held 3,770 modules and 83 MiB.
These timings exclude hosted cache transfer and do not establish a PR saving.

Correctness probes found eight changes that incorrectly kept a test passing
against the old transformed import or compiler output:

| Change after warming                                              | Raw cache  | Startup fingerprint |
| ----------------------------------------------------------------- | ---------- | ------------------- |
| Add preferred `value.js` beside previously resolved `value.ts`    | False pass | Correctly fails     |
| Retarget a source symlink while its old target still exists       | False pass | Correctly fails     |
| Change an inlined package's `exports` to another existing file    | False pass | Correctly fails     |
| Add a preferred extension in a generated source directory         | False pass | Correctly fails     |
| Change TypeScript's JSX factory in `tsconfig.json`                | False pass | Correctly fails     |
| Create the preferred file from setup after startup fingerprinting | False pass | False pass          |
| Add a preferred file inside an external symlinked directory       | False pass | False pass          |
| Change an external file read by a transform plugin                | False pass | False pass          |

The fingerprint included file names/types, symlink targets, package/config/
TypeScript metadata contents, and effective alias/define options. Following
external symlink inventories and hashing declared transform inputs repaired the
last two rows, but did not repair files created after fingerprinting. All ten
cache-disabled changed-input controls failed correctly; initial and repeated
warm controls passed. Effective alias and simple define changes also invalidated
correctly without the added fingerprint.

The [Vitest 4.1.11 documentation](https://github.com/vitest-dev/vitest/blob/v4.1.11/docs/config/experimental.md#known-issues)
documents incomplete plugin-input tracking. Its
[cache implementation](https://github.com/vitest-dev/vitest/blob/v4.1.11/packages/vitest/src/node/cache/fsModuleCache.ts)
hashes the module and selected configuration, but retains previously resolved
import URLs. [Upstream fix #11381](https://github.com/vitest-dev/vitest/pull/11381)
merged September 29 and revalidates those URLs. A disposable Vitest 5.0.3 probe,
which contains that fix, reproduced all eight false-pass categories: the old
target still exists, so checking its resolved URL misses a newly preferred file
or changed package export. Upgrading alone does not make reuse safe.

To reproduce the simplest negative control outside the worktree:

1. Create `value.ts` containing `export const value = 1`, and a test importing
   `./value` and asserting `expect(value).toBe(1)`. Use an isolated config/cache,
   one fork worker, `ORCA_BACKGROUND_LAUNCH=1`, and
   `NODE_DISABLE_COMPILE_CACHE=1`.
2. Run the installed CLI with `--experimental.fsModuleCache=true` to warm it.
   Add `value.js` containing `export const value = 2`; retain `value.ts` and the
   unchanged test. The same cached invocation incorrectly passes.
3. Repeat with `--experimental.fsModuleCache=false`. The assertion correctly
   fails. Vitest 5 uses `--fsModuleCache` for the equivalent controls.
4. For the startup-inventory control, use unchanged setup code that creates
   `value.js` only when a runtime environment switch is enabled. Remove that
   file before each invocation/fingerprint; warm with the switch off, then run
   with it on. The cached importer still points at `value.ts`, while the fresh
   module graph correctly fails. This is an additional persistent-cache error,
   not a claim that normal in-process module reuse supports arbitrary mutation.

Orca currently resolves only pinned Vitest/Vite built-in transform plugins.
Its setup files install runtime guards/shims and temporary user data, rather
than custom transforms. A narrower policy could cache only proven immutable
source/dependency inputs and leave tests, setup, virtual modules, external
fixtures, and unknown plugins cold. That requires a validated transitive input
boundary and mutation policy; hashing every source tree on each lookup would
also spend the gain. Until that policy and hosted transfer cost are measured,
the local warm result does not justify adding a persistent cache to CI.

## Test fixture imports: reuse the existing narrow builder

The pointer-drag test imported only `makeWorktree` from `store-test-helpers`,
which also loads the real store slices. Its existing identical export in
`worktrees-slice-test-fixtures` supplies the same defaults without that graph.
Changing this single import preserves the five tests, fork workers,
isolation, and disabled filesystem/Node compile caches.

Three local interleaved before/after pairs took 2.066/2.047/2.031 seconds versus
0.351/0.388/0.353 seconds: the isolated median fell 82.7%, from 2.047 to 0.353
seconds. Transformed modules fell from 1,086 to 15. This is an isolated test
result, not a whole-shard estimate: other tests need the store modules anyway.
A broader 20-file screening sample saved only 0.295 seconds at its median,
which does not justify splitting the fixture module across those consumers.

Two further import-only reuses passed the same six-run controls. The kanban
lane test mocks its card component, so switching its builder import reduced
the isolated median from 2.202 to 0.495 seconds (77.5%) and transformed modules
from 1,082 to 13, with all six tests unchanged. The autosave fixture needs
the real editor slice, but not every store slice: the same import change across
its three consuming suites reduced the median from 3.027 to 1.301 seconds
(57.0%), with 1,107 to 320 modules and all 17 tests unchanged. These
results also measure isolated file groups; they are not additive shard savings.
The remaining inspected builder-only imports already load the full store as
their subject, or use builders whose defaults differ from existing exports.

## Vitest threads: retain forks after the scoped pilot

Three local interleaved comparisons kept four workers, `isolate: true`, both
persistent caches disabled, and the same test assertions/module graph. The
94-file happy-dom renderer cohort passed all 570 tests: forks took
17.480/17.382/17.657 seconds and threads 15.048/14.890/15.013 seconds, a 14.1%
median reduction. A 23-file shared JavaScript cohort passed all 248 tests,
with its median falling from 1.435 to 1.274 seconds (11.2%). No main-process
module or native addon loaded; guards reject native loading, `chdir`, and
process signals. These Mac/Node 24 timings motivated the hosted comparison.

The [pinned Vitest pool documentation](https://github.com/vitest-dev/vitest/blob/v4.1.11/docs/config/pool.md)
defaults to forks and documents thread limitations around process APIs and
native libraries. [Node's worker documentation](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)
also excludes V8 flags from worker `execArgv`. Orca's `--expose-gc` worker flag
fails with `ERR_WORKER_INVALID_EXEC_ARGV` under threads. The experiment starts
both parent processes with that flag, retains it on fork workers, and removes
it only from thread worker arguments; GC availability is checked in every
test environment. Process, native, lifecycle, and GC-retention tests stay out
of this comparison.

The [hosted pilot](https://github.com/stablyai/orca/actions/runs/36855833033)
passed on Linux ARM64, four CPUs, Node 24.21.0, and Ubuntu image
`20260927.135.1`. Three alternating pairs preserved source hashes and complete
module graphs, with no main-process module or native addon loaded:

| Audited cohort                         | Forks, seconds           | Threads, seconds         | Median saving         |
| -------------------------------------- | ------------------------ | ------------------------ | --------------------- |
| 94 renderer files / 570 tests          | 48.591 / 48.144 / 47.299 | 42.486 / 42.402 / 42.221 | 5.742 seconds (11.9%) |
| 23 shared JavaScript files / 248 tests | 3.386 / 3.330 / 3.424    | 3.203 / 3.237 / 3.278    | 0.149 seconds (4.4%)  |

Each timed group also included two isolation sentinels: totals were 96 files /
572 tests and 25 files / 250 tests, respectively, with no skips.
Their graph hashes matched in every pair (4,015 and 251 modules). Separate
single-worker positive controls passed both sentinels in each pool. With
isolation disabled, the second sentinel correctly failed on leaked state.
Missing GC failed setup, and native loading, `chdir`, and process-signal probes
failed at the guard in both pools. Those expected failures did not pass silently.

The fixed 117-file sample accounts for about 1.5% of the baseline's aggregate
module time; its isolated gains are not a whole-suite estimate. Maintaining
that exact file list for this benefit is not justified. A broader route needs
a safe eligibility policy, Node 26/Windows evidence, and a mixed full-shard
comparison: separate Vitest projects can repeat shared transforms and erase
the pool-startup saving. A renderer path alone does not prove that future
imports avoid process or native behavior. Production retains forks, and the
temporary workflow, driver, and cohort list were removed after measurement.

## Oxlint scan consolidation: rejected

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/36855833063)
used one Linux ARM64/four-CPU runner, Node 24.21.0, and three alternating
baseline/candidate pairs. The baseline kept root lint and anti-slop in parallel,
then native and type-aware audits in parallel. The candidate merged the first
three scans and ran the unchanged type-aware audit alongside them.

| Pair/order         | Baseline stage | Candidate stage | Change |
| ------------------ | -------------- | --------------- | ------ |
| 1: baseline first  | 49.409 s       | 53.197 s        | +7.7%  |
| 2: candidate first | 50.249 s       | 60.297 s        | +20.0% |
| 3: baseline first  | 50.040 s       | 56.672 s        | +13.3% |
| Median             | 50.040 s       | 56.672 s        | +13.3% |

These complete stage timings include anti-slop synchronization in both variants
and candidate configuration generation. Candidate preparation took only
0.141–0.255 seconds. The unchanged type-aware scan took 16.386–17.279 seconds
in the baseline wave, versus 33.561–55.736 seconds beside the merged scan;
these timings are consistent with contention on the four-CPU runner.

The corrected local Mac/16-CPU comparison had reduced the median from 16.676
to 14.381 seconds (13.8%). Both comparisons limited each Oxlint invocation to
four threads and used identical source configuration hashes. The hosted result
shows why the local gain did not justify adoption on the actual CI runner.

Coverage controls passed: the merged scan matched the exact 28,621-file union
with no missing or extra files. Thirty-one fault fixture files produced the
exact 16-diagnostic union, including all seven active root JavaScript rules.
Eighteen focused controls preserved nested-mobile exemptions, type-aware
exclusions, and exit behavior. The native audit's warnings still failed its
original `--deny-warnings` gate and became errors in the merged scan; root
warnings remained non-fatal. Every full-repository scan passed cleanly.

Keep the existing production waves. The temporary workflow and 601-line
benchmark driver were removed after recording this rejected result.
