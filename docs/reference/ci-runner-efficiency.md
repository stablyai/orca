# CI efficiency and runner capacity

The [September 28 demand rollout](ci-demand-rollout.md) documents staged checks,
unit-selection evidence, headless runtime qualification, review cancellation and daily occupancy reports.

## Headless server follow-up

[PR #24527](https://github.com/stablyai/orca/pull/24527) adds dependency detection to
main pushes. Unrelated pushes skip qualification; relevant pushes still run all
six persistence targets and five Linux compatibility jobs. Explicit Windows or
Mac PR paths select both architectures plus a Linux smoke, while shared
execution/storage changes, SSH/provider/relay inputs, native inputs, manifests, and incomplete evidence
retain the full matrix. Main pushes use the same validated exact Windows slot
cache as PRs; nightly and release builds still compile freshly.

Main detection runs cannot cancel each other. Only eligible qualification jobs
share main concurrency groups, so an unrelated push cannot cancel needed tests.
Release templates, explicit refs, and nightly runs remain isolated.

Draft PRs have no server verdict, so their detector is also skipped. The existing
`ready_for_review` event performs detection and qualification once the PR is ready.
This removes the checkout and dependency installation for a result whose platform
jobs were already ineligible.

The glibc 2.28 prerequisite step checks all five tools before installing anything.
The pinned ARM image already supplies them, including Git 2.55.0 built under
`/usr/local/bin`; installing the Git RPM does not change the Git on PATH. A
missing-tool fallback still installs the original package list and disables EPEL
for that one command. In
the baseline x64 log, EPEL metadata took 4 minutes 50 seconds to download although
every installed package came from AlmaLinux BaseOS or AppStream. The package list,
compiler image, libc floor, native smoke, and persistence tests stay unchanged.
The [DNF command reference](https://dnf.readthedocs.io/en/stable/command_ref.html)
defines `--disablerepo` as a temporary command-level filter, so later commands
retain the image's repository configuration.

The [PR qualification run](https://github.com/stablyai/orca/actions/runs/36972824276/job/110734327685)
passed the x64 floor native smoke and persistence suite. Its prerequisite step
finished within GitHub's one-second timing resolution, compared with 5 minutes
37 seconds in the baseline job; the supplied tools needed no package install.
This measures that step, not the complete workflow or its queue time.

A [completed main run](https://github.com/stablyai/orca/actions/runs/36962172614)
used 42 aggregate runner-minutes across 11 test jobs. The
[latest daily demand report](https://github.com/stablyai/orca/actions/runs/36965354205)
estimates 34.9 headless runner-hours, including 23.4 in cancelled runs. These are
baseline observations; post-merge savings have not yet been measured.

## October 4 clock, byte and import test fixtures

These changes retain production behavior, original case names and platform
outcomes. The paired pilots use three alternating one-worker Node 24 invocations
on Ubuntu 24 ARM. Every median below is a complete focused test invocation;
they do not establish whole-shard savings or queue-delay improvements.

| Workload                                             | Baseline median | Candidate median | Reduction | Hosted evidence                                                          |
| ---------------------------------------------------- | --------------- | ---------------- | --------- | ------------------------------------------------------------------------ |
| Codex settlement and Claude stop deadlines, 35 cases | 35.914s         | 10.142s          | 71.8%     | [37186232658](https://github.com/stablyai/orca/actions/runs/37186232658) |
| Native-chat delivery, 15 cases                       | 22.321s         | 7.376s           | 67.0%     | [37183731823](https://github.com/stablyai/orca/actions/runs/37183731823) |
| Six profile-storage byte suites, 118 cases           | 12.629s         | 9.978s           | 21.0%     | [37183141654](https://github.com/stablyai/orca/actions/runs/37183141654) |
| Encrypted account storage, six cases                 | 18.277s         | 0.958s           | 94.8%     | [37184007241](https://github.com/stablyai/orca/actions/runs/37184007241) |
| SSH remote commands, 27 cases                        | 6.840s          | 6.078s           | 11.1%     | [37184454532](https://github.com/stablyai/orca/actions/runs/37184454532) |
| OpenCode subscription, 28 cases                      | 47.347s         | 6.284s           | 86.7%     | [37184858823](https://github.com/stablyai/orca/actions/runs/37184858823) |
| Window-service attachment, 31 cases                  | 11.910s         | 1.619s           | 86.4%     | [37186340840](https://github.com/stablyai/orca/actions/runs/37186340840) |
| OpenCode 2 TUI ownership, 41 cases                   | 16.811s         | 2.429s           | 85.6%     | [37187699312](https://github.com/stablyai/orca/actions/runs/37187699312) |
| Title-send authorization, nine cases                 | 29.545s         | 12.995s          | 56.0%     | [37188423318](https://github.com/stablyai/orca/actions/runs/37188423318) |
| Range selection, 15 cases                            | 9.737s          | 7.130s           | 26.8%     | [37188996198](https://github.com/stablyai/orca/actions/runs/37188996198) |

Provider tests wait for the real fake-child write/ready barrier and drain the
host stream before installing a scoped parent clock. The original 2.5/5-second
Codex and 3-second Claude deadlines remain; before/at assertions check their
boundaries. Early rejection and refusal resolve without waiting on an unreachable
barrier; finally and suite teardown restore clocks and spies even after a native
Vitest timeout. Four healthy failure-path controls pass; old-helper hangs and
removed teardown are caught. Missing-child failure retains a real ten-second observation window.
Six faults for early/late stop deadlines, late queued resend and missing child
output fail the intended assertions. Native-chat tests still use the real React
outbox hooks. Their scoped clock retains probe, retry, churn and target-switch
windows, drains async act work, and unmounts before clock restoration. All eight
hook faults fail; two boundary faults pass the old coarse tests and fail the new
before/at assertions. Node/web typecheck, lint and formatting pass.

Native Buffer.equals replaces deep per-byte assertion traversal. It checks the
complete original bytes and length; fixtures, SQLite operations, encryption and
processes are unchanged. The six profile suites retain 114 passes and four
existing Linux case-sensitivity skips; all 118 pass locally on macOS. Seven
profile last-byte/length faults and two encrypted-vault last-byte/length faults
fail their exact byte assertions. All six encrypted-vault cases still exercise
52 accounts near the 4 MiB encrypted cap, refused growth, restart/readback and
private permissions.

The old SSH fixture created 15,197 short stage paths but never exceeded the real
1,048,576 UTF-16-character transport tail cap; its two valid entries also left
the 64-result assertion vacuous. The replacement uses about 1,300 real excluded
stage directories under long Unicode path components, a real shell channel and
the production execCommand limiter. Actual find output exceeds that cap, while
the generated filter retains both original valid entries. A separate population
of 65 valid directories proves the first-64 limit and native find ordering. File,
symlink, nested-install and failed-enumeration checks remain. All 27 case outcomes
match across treatments (23 passes and four unavailable PowerShell 5.1 skips on
the hosted image). Eight cap, ordering, filtering and failure faults are caught.
Paths use platform utilities; local PowerShell availability retains its original
skip policy. The deadline and SSH fixtures reuse existing process/stream code.
OpenCode subscription tests batch only uninterrupted fixture writes between the
original observation barriers. Both SQLite schema versions keep every row, rowid,
read cap, poll, clock position and case. No durability pragma or production code
changes. All 28 cases pass in every pair. Separate captures compare ordered
schema and rows, transaction state, pragmas, signals, page requests/results and
subscriber callbacks: 124,754,101 payload bytes match, canonical digest
`ba0eb6f09281746071d73fae88e2e8eb45332f36892b90998b374b1b8c59b3e3`.
Missing rows, collapsed frontier rowids, read-cap overruns, missing commit and
missing rollback each fail the intended case in both schemas. Positive rollback
controls pass. The unmeasured full-suite timing report ranked this fixture at
134.229 seconds; the paired 47.347-second figure above is the relevant focused
baseline, and the two figures must not be mixed into a claimed saving.

Window attachment tests mock five unrelated registrar modules using their actual
types. The existing window ownership, reload, media permission, native file drop,
hydration barrier and updater scheduling cases remain real. Exact store/runtime/
window arguments and daemon registration after the PTY handler are now asserted;
nine actual production wiring/order faults fail. The registrar implementations
retain separate handler tests. Concrete existing stubs moved to one fixture to
stay within the line limit. All 31 cases and statuses match across all pairs. The
final source differs from the timed source only by a required type-assertion
safety comment.
OpenCode 2 TUI tests use a scoped async clock only after the first real native
module import. The unchanged generated plugin runs against the existing fake TUI
and fetch. Original poll, permission, retry, preview, slow POST and endpoint
windows remain. Before/at assertions pin the 100 ms poll, 500 ms permission,
120 ms slow POST and 5-second endpoint boundaries. All 41 original case outcomes
match. Separate ordered captures preserve 678 TUI/event rows and 362 complete
POST start/completion rows; wall timestamps and cross-stream interleaving are
excluded from equivalence. Eleven generated-source faults fail their intended
identity, reload, order, deadline or timer-cleanup assertions. Four import/setup/
disposer rejection and timeout controls confirm restoration of clocks, fetch,
argv and environment. Teardown holds its fake clock through bounded native cleanup and pending-timer checks, then restores real clocks. The [teardown qualification](https://github.com/stablyai/orca/actions/runs/37195736834) passes all 41 cases and 12 failure and restoration control invocations, including interval and retry leaks missed by the earlier teardown.
Title-send authorization tests retain real terminal creation, graph binding and
positive evidence paths. Negative process-evidence probes use scoped clocks
after setup: both 150 ms polling loops retain their 6,500 ms budget, crossed at
6,600 ms, and the send guard retains its 1,050 ms deadline. Before/at assertions
check 6,599/6,600 and 1,049/1,050 ms. All nine original cases remain. Actual
early/late wrapper and guard deadlines, false spinner identity and unknown-agent
authorization faults fail their intended assertions; native clocks and runtime
instance spies are restored after each failure.
Range-selection tests stub only the saved-note send menu, which their empty
comment populations never render. A facade typed from the actual menu props
throws if invoked, and an afterEach assertion verifies no call with unconditional
mock clearing in finally. The real hook, Monaco constants/model, line and range
drag behavior, draft-card lifecycle and open-inline-card chord remain. All 15
original test bodies are byte-unchanged. Three actual range/hunk/draft faults
fail their original assertions; a real draft-render menu call hits the facade
and sentinel, and an outer cleanup check proves mock state cleared after failure.
The actual saved-note menu retains its independent component tests.

## October 2 headless detector compiler cache

The deferred detector already avoids dependency setup for known build inputs.
For changes that need import analysis, the collector marks package imports external;
only esbuild and its platform binary are needed. A small compiler archive can replace
root dependency setup for this analysis, while qualification jobs still install normally.

The existing Linux x64 warmer packs these two packages after its frozen,
script-free, policy-checked install. Only main publishes. Readers use an exact key
covering Node/platform/architecture, manifests, install policy, patches and the cache
implementation. The producer and reader use the same archive path. File hashes,
identity and a compiler smoke are checked before availability is reported; missing,
invalid or failed restores use the original full installer. Graph analysis retains
its existing conservative full-qualification verdict on errors.

A [three-pair hosted comparison](https://github.com/stablyai/orca/actions/runs/37071724200)
passed on Ubuntu x64 with Node 24.21.0 and esbuild 0.28.2. Every pair produced the
same 6,018 source inputs. Sample 2 ran the compiler-only treatment first; samples 1
and 3 ran the existing installer first. Each used a fresh dependency tree, and the
compiler treatment required a real cache hit and validated its bytes and smoke.

| Sample | Full installer + graph | Compiler restore + graph | Paired saving |
| ------ | ---------------------- | ------------------------ | ------------- |
| 1      | 11.730s                | 2.805s                   | 8.925s        |
| 2      | 14.702s                | 4.706s                   | 9.996s        |
| 3      | 14.666s                | 3.750s                   | 10.916s       |

The median paired saving is 9.996 seconds. Inter-step overhead, archive transfer,
validation and the real graph are included. Checkout, initial Node setup, dependency
resets, seed work, post-job cache saves, tests and queues are excluded. These are
warm detector measurements, not whole-workflow or billing savings. The trial uses
the same package layout and validation as the production helper; production also
resolves its policy fingerprint. Cold or changed identities still install fully.

## SSH Windows slot reuse

The SSH Windows host workflow uses the same server-slot preparation action as
headless qualification. Its four PR jobs can restore the exact slot published by
fully qualified main runs, then validate its inventory and hashes and run the
required-slot and pinned-Node smoke checks. Misses or invalid payloads compile
freshly. Only main headless qualification publishes; manual SSH qualification
still builds freshly. Both sshd versions, both architectures, all three host
cells, the process-table addon build, and the template/relay builds remain.

The action is part of the cache fingerprint, so this extraction starts a new
namespace that needs a successful main seed. The existing hosted measurements
below suggest about 160 aggregate runner-seconds saved across four warm SSH jobs;
that is a conditional estimate, not a measured improvement of this consumer.
Private sshd installation and host execution still dominate this workflow.

## Prepared relay addon reuse

A [completed SSH Windows run](https://github.com/stablyai/orca/actions/runs/36972043877)
rebuilt the process-table relay addon after native dependency preparation. From
its builder's start message to the validated staged artifact, x64 took 85.5 seconds
and ARM64 took 135.6 seconds. These are single-run observations, not medians.

An opt-in reuse path checks the same binary architecture, patched reader and
launcher exports as staging, then runs the existing native-load and CreationTime
probe. Repaired source or incomplete evidence requires a fresh build. SSH PRs
request reuse only following an exact prepared native-cache hit; manual SSH and
all release builders retain fresh compilation. Subsequent staging checks still
run. Hosted validation and the reuse interval remain to be measured.

## Windows root download stores: registry installs finish sooner

Three paired samples on each Windows architecture compared the existing exact
main download-store restore with a fresh registry install. Each treatment used a
fresh dependency tree, store and pnpm metadata, with registry-first ordering in
sample 2. Both restored the same policy-checked verification record before timing.
All six pairs used Node 24.21.0 and pnpm 12.8.1; manifest digests and installed
lockfile digests matched, and both retained frozen, script-free installation.

| Runner        | Cached totals (seconds)     | Registry totals (seconds)   | Paired median saving |
| ------------- | --------------------------- | --------------------------- | -------------------- |
| Windows x64   | 26.820 / 28.885 / 27.751    | 13.644 / 14.126 / 12.908    | 14.759 seconds       |
| Windows ARM64 | 216.540 / 288.492 / 189.342 | 119.856 / 238.562 / 115.611 | 73.731 seconds       |

The x64 samples are the three successful Windows 2022 jobs in
[run 37064549378](https://github.com/stablyai/orca/actions/runs/37064549378).
Its ARM cleanup guard rejected pnpm's setup-owned store path before measurement;
those incomplete ARM jobs are excluded. The corrected
[ARM-only run](https://github.com/stablyai/orca/actions/runs/37065220916) passed all
three samples. Earlier rejected measurements also stopped before installation
because an optional config file was absent; none count toward these timings.

Intervals include actual store lookup/restore, inter-step overhead and root
installation. Checkout, toolchain setup, tree/store reset, verification-record
restoration and native preparation are excluded. ARM variation is substantial;
these samples do not measure whole-workflow, queue or billing savings.

Root-only Windows x64/ARM64 PR installs now skip the download-store restore.
The existing x64 mixed-install exception remains. An explicit store opt-out also
lets Windows headless persistence and SSH jobs avoid the archive on main or
manual runs. Frozen installs, verification records, native caches and every
qualification check remain. Other lockfile sets and platforms keep their
existing policy. Default non-PR writers, including the warmer, still seed stores
for direct setup-node consumers and workflows that run package scripts.

## October 2 Linux root store comparison

A [six-job hosted comparison](https://github.com/stablyai/orca/actions/runs/37073978443)
measured the actual main root-store archive against direct registry installation,
with three fresh-runner pairs on each Linux architecture. All six jobs passed.
The middle sample on each architecture reversed treatment order. Between treatments,
the driver removed the dependency tree, store and pnpm metadata, then restored the
same policy-checked verification record before timing. Frozen, script-free installs
preserved policy files and produced identical installed lockfile digests in each pair.

| Architecture/sample | Store restore + install | Direct registry install | Paired saving |
| ------------------- | ----------------------- | ----------------------- | ------------- |
| x64 / 1             | 6.516s                  | 5.372s                  | 1.144s        |
| x64 / 2             | 6.743s                  | 3.950s                  | 2.793s        |
| x64 / 3             | 6.600s                  | 3.985s                  | 2.615s        |
| ARM64 / 1           | 7.632s                  | 3.346s                  | 4.286s        |
| ARM64 / 2           | 5.504s                  | 3.575s                  | 1.929s        |
| ARM64 / 3           | 5.450s                  | 3.364s                  | 2.086s        |

Median paired savings are 2.615 seconds on x64 and 2.086 seconds on ARM64; means
are 2.184 and 2.767 seconds. Both used Node 24.21.0 and pnpm 12.8.1. Actual store
lookup/transfer/restore, inter-step overhead and installation are timed. Checkout,
initial toolchain/dependency setup, preparing the existing process wrapper,
dependency resets, verification-record restores, native work, tests, post-job cache
saves and queues are excluded. Package services have already been used by initial
setup. These are warm-policy setup measurements, not workflow or billing savings.

The shared installer consequently skips root-only Linux x64/ARM64 store restores
on PRs. It still installs and checks every package through pnpm. Mixed mobile and
custom lockfile sets, other architectures, verification/native caches,
main store writers and release installation policies keep their existing behavior.
The measured Windows exceptions remain. Mac restores were retained at this stage;
the following comparison supersedes that policy. No periodic job or cache is added.

## October 2 macOS root store comparison

A [six-job hosted comparison](https://github.com/stablyai/orca/actions/runs/37078232553)
used the same paired method on macOS 15 Intel and Apple Silicon. All six jobs
passed with actual main store cache hits. The middle sample reversed treatment
order. Each treatment started with a reset dependency tree, store and pnpm
metadata, followed by the same verification-record restore. Policy files and
installed lockfile digests matched within every pair.

| Architecture/sample | Store restore + install | Direct registry install | Paired saving |
| ------------------- | ----------------------- | ----------------------- | ------------- |
| x64 / 1             | 87.270s                 | 60.584s                 | 26.686s       |
| x64 / 2             | 103.280s                | 52.640s                 | 50.640s       |
| x64 / 3             | 61.564s                 | 40.768s                 | 20.796s       |
| ARM64 / 1           | 26.024s                 | 14.375s                 | 11.649s       |
| ARM64 / 2           | 37.000s                 | 19.726s                 | 17.274s       |
| ARM64 / 3           | 34.616s                 | 14.888s                 | 19.728s       |

Median paired savings are 26.686 seconds on x64 and 17.274 seconds on ARM64;
means are 32.707 and 16.217 seconds. Node matched within each pair: 24.19.0 on
Intel and 24.20.0 on Apple Silicon, as resolved by the existing installer. Both
used pnpm 12.8.1. Timing includes actual cache lookup/transfer/restore, inter-step
overhead and installation. Checkout, initial setup, process-wrapper preparation,
resets, verification restores, native work, tests, cache saves and queues are
excluded. Initial setup has already used package services. These measurements
do not establish whole-workflow or billing savings.

The existing root-only PR exception now also covers macOS x64/ARM64. Frozen,
script-free installs and pnpm policy checks still run. Mixed/custom lockfile sets,
other architectures, verification/native caches, main/manual store writers and
release installation policies retain their existing behavior. No periodic job
or cache is added.

## October 2 store producers: keep caches without downloading hits

The optional `cache-pnpm-store-lookup-only` installer input uses
[`actions/cache` lookup-only](https://github.com/actions/cache#inputs) on non-PR
runs. An exact hit refreshes cache access without extracting the archive; a miss
still installs from the registry and publishes the populated store at successful
job completion. The default remains the existing `setup-node` cache behavior.
The four Linux/Windows dependency warmers and Linux/macOS persistence producers
opt in. Windows persistence retains its existing store opt-out, and PR restore
policies are unchanged. This adds no recurring job or extra cache family.

A [tiny framework control](https://github.com/stablyai/orca/actions/runs/37082688033)
proved that lookup left the payload absent, refreshed the existing cache's access
time, and published a miss that a fresh job restored. A
[nested composite control](https://github.com/stablyai/orca/actions/runs/37084946789)
then saved and restored a fresh payload using the actual environment-path pattern.
The installer exports its resolved store path through `GITHUB_ENV`: twice-nested composite post-job saves
cannot resolve their internal step outputs. The primary key is captured
by the cache action before cleanup. Paths, architecture and lockfile keys match
`setup-node`, so existing default-branch archives remain reusable.

The [six-platform installer screen](https://github.com/stablyai/orca/actions/runs/37084946789),
[Linux repeats](https://github.com/stablyai/orca/actions/runs/37085164277), and
[corrected Windows repeats](https://github.com/stablyai/orca/actions/runs/37085248976)
compared the complete shared installer, including toolchain setup, cache actions,
policy verification, frozen installation and native probes where requested.
Each treatment reset dependencies, the store, pnpm metadata and the Windows
registry build directory. Treatment order reversed across architectures and
repeats. Every qualified pair required real main store cache hits, matching
policy/installed-lockfile digests and Node/pnpm versions, plus exact native-cache
hits on Linux and Windows. The initial Windows x64 screen stopped before timing
because its benchmark guard rejected the standard `D:\.pnpm-store` path; that
unqualified job is excluded.

| Platform / sample        | Restore + installer | Lookup + installer | Paired saving |
| ------------------------ | ------------------: | -----------------: | ------------: |
| macOS ARM64              |             37.785s |            20.024s |       17.761s |
| macOS x64                |             75.610s |            46.638s |       28.972s |
| Linux ARM64 / 1          |             10.005s |             7.242s |        2.763s |
| Linux ARM64 / 2          |              8.817s |             6.672s |        2.145s |
| Linux ARM64 / 3          |              8.800s |             6.581s |        2.219s |
| Linux x64 / 1            |             12.309s |             9.735s |        2.574s |
| Linux x64 / 2            |             10.131s |             8.690s |        1.441s |
| Linux x64 / 3            |             13.741s |             9.485s |        4.256s |
| Windows ARM64 / repeat 1 |            145.818s |            78.729s |       67.089s |
| Windows ARM64 / repeat 2 |            152.730s |           106.475s |       46.255s |
| Windows ARM64 / screen   |            294.092s |           193.957s |      100.135s |
| Windows x64 / 1          |             30.936s |            20.256s |       10.680s |
| Windows x64 / 2          |             31.021s |            20.098s |       10.923s |

All 13 qualified pairs improved. Median paired savings were 2.574 seconds on
Linux x64, 2.219 on Linux ARM64, 10.802 on Windows x64 and 67.089 on Windows
ARM64. Each macOS architecture had one pair; its 28.972 / 17.761 second savings
are a screen, supported by the earlier three-pair root-store comparisons.

All pairs used pnpm 12.8.1. Node was 24.21.0 on Linux and Windows, 24.19.0 on
macOS Intel and 24.20.0 on macOS ARM. Source dependency policies were frozen for
this screen; later main dependency changes do not extend these measurements.
Timing excludes checkout, initial service/bootstrap use, wrapper compilation,
resets, result validation, post-job saves and queues. These are installation
measurements, not whole-workflow or billing savings. Cold publication is verified
separately by the small controls; no large synthetic store cache was uploaded.

## October 1 Windows and dependency cache follow-up

[PR #24355](https://github.com/stablyai/orca/pull/24355) merged at `197ea3a3`.
The [next hosted trial](https://github.com/stablyai/orca/actions/runs/36917210453)
ran four alternating pairs on each Windows architecture and both Mac
architectures. All six jobs passed. The exact temporary workflow and drivers
remain available at `ab24952ab5af0f7d8e53a544896ac2486edfb244`; completed trial
tooling is removed from ordinary PR CI.

### Windows server slots

The existing dependency-native cache and the server's N-API 8 slot serve different
consumers. Cache the small server slot separately, using the exact compiler image,
architecture, dependency/patch/runtime inputs and compilation/validation source.
PR and main-push qualification restore it. Nightly qualification still compiles
freshly; main saves after persistence/lifecycle tests and the existing x64 Node 18 handoff.
Templates and explicit-ref calls continue to compile freshly.

| Hosted runner    | Fresh build median | Restore median | Difference |
| ---------------- | ------------------ | -------------- | ---------- |
| Windows 2022 x64 | 18.624s            | 4.677s         | 13.947s    |
| Windows 11 ARM64 | 72.002s            | 6.111s         | 65.891s    |

Both used Node 24.21.0. Each comparison includes actual GitHub cache restoration,
inter-step time, payload validation, required-slot checks and pinned-Node load/spawn
smoke. Every fresh build uses the builder's freshly cleared compilation directory.
Dependency installation, initial seed work, shared download warmup, full qualification
tests and queues are outside these timing intervals. The x64 payload was 2,935,529
bytes and ARM64 3,533,557 bytes. These are conditional warm-hit gains, rather than a
whole-workflow improvement or the roughly 95–117 seconds seen in earlier cold samples.

Restored bytes must match current module/version/headers/N-API/host metadata,
the complete inventory and hashes, and current vendored ConPTY files. Existing
patch, PE architecture, post-baseline N-API and MSYS breakaway checks are reused.
Failed or partial restoration and invalid payloads clear only `out/orcad-prebuilds`
and fall back to normal compilation. Both fresh seeds and fresh restored consumers
passed the full existing Windows qualification; x64 also passed Node 18 handoff.
The final key additionally includes the ten transitive process-wrapper sources.

A bounded sample of 50 first-parent main commits through `197ea3a3` had 45 of 49
adjacent transitions with identical source inputs, including those ten files.
This one-day sample holds the new validator and runner image constant. Actual
image rotation, seed availability and changed PR inputs can reduce reuse.

Keep the original Windows native dependency preparation: artifact-mode tests still
import checkout `node-pty`, registry and process-reader addons, and the Windows
artifact builder stages the patched process reader. The cached server slot does
not replace those dependencies.

### pnpm verification records

Reuse pnpm's existing policy-checked record on Windows x64/ARM64 and Mac Intel,
while retaining Linux's existing behavior. The exact OS/architecture/pnpm/policy
key, explicit opt-out, frozen installs and main-only production writes remain.
Each treatment resets links and registry metadata, retains the identical warm
download store, and checks unchanged manifests, installed versions and installed
lockfile bytes. Every platform passed real missing/corrupt-record fallback and
changed-policy/changed-integrity rejection controls, plus authentic cross-path reuse.

| Platform               | Baseline install | Cached install | Baseline interval | Cached interval |
| ---------------------- | ---------------- | -------------- | ----------------- | --------------- |
| Windows x64            | 13.105s          | 9.767s         | 17.717s           | 15.146s         |
| Windows ARM64          | 96.723s          | 88.443s        | 164.620s          | 157.877s        |
| Mac Intel              | 31.368s          | 21.042s        | 47.727s           | 41.302s         |
| Mac ARM, kept disabled | 11.419s          | 8.086s         | 17.905s           | 15.787s         |

Install columns time pnpm alone. Interval columns also include link reset,
path validation, real cache restoration and inter-step overhead; they exclude
seed setup, parity checks and queues. Key-resolution overhead is outside the paired
trial; the real Windows ARM production-shaped step took 0.296s. Windows ARM's first
pair was slower with the record, while the next three improved, so its median is
not a guaranteed per-job saving. Macs used their hosted Node 24.19.0 Intel and
24.20.0 ARM toolchains; Windows used 24.21.0, and all used pnpm 12.0.0.

An earlier complete Mac ARM trial saved only 0.681s in its interval median.
That small, variable margin does not justify enabling the extra lookup there.
Only the tiny pnpm-owned record is restored; registry metadata and download-store
policy are unchanged. Changing the shared action also produces a one-time cold
native dependency cache key, whose existing hash includes the action bytes.

### Further local screens rejected

A fixed 256-file, 2,471-case cohort preserved every result in twelve invocations.
Lazy per-file user data showed a noisy 2.0% wall difference with no setup-time
improvement; combining DOM setup was 1.8% slower. A separate seven-file leaf-import
screen preserved all 50 assertions and public/hook controls, saving only 0.903
worker-seconds while elapsed time rose 2.55%. All experiments were reverted.
Documentation-result reuse also lacked positive eligible demand in the bounded
sample, and the apparent example changed the actual tested merge/base inputs.
These results do not justify adding a new coverage-selection or result-reuse policy.

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

The sequential gate in [October 4 shared PR preflight capacity](#october-4-shared-pr-preflight-capacity) supersedes the earlier rejection below.

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
  state on the default branch when dependency/toolchain inputs change, with
  scheduled recovery (originally hourly; now every six hours). One ten-minute-bounded hosted job
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

## Native cache ownership: retain the extraction

Native restoration, toolchain recovery, and preparation now belong to
`.github/actions/prepare-native-runtime/action.yml`. The installer forwards
its requested key and three build paths; Windows packaging saves the Node
build before calling the same action for Electron. Existing native load,
patched-build, Windows job-ownership, registry, and process-table probes remain
unchanged on restored consumers. Exact keys still separate OS/image or Linux
container libc, architecture, runtime, resolved Node version, and actual pnpm
version, without partial-key restoration.

The source hash covers the dedicated action, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, both native dependency patches,
and these complete build/probe inputs:

- `config/scripts/ensure-native-runtime.mjs`, `rebuild-native-deps.mjs`,
  `node-pty-job-ownership.cjs`, `windows-pe-machine.cjs`,
  `windows-process-tree-gyp-rebuild.mjs`, and
  `windows-process-tree-creation-time.cjs`;
- `config/scripts/install-electron-package-binary.mjs`,
  `electron-platform-path.mjs`, `zip-extractor-command.mjs`,
  `shared-electron-dist-cache.mjs`, `space-sharing-copy.mjs`, and
  `src/shared/zip-extractor-command.ts`;
- `native/windows-registry/src/addon.cc`, `binding.gyp`, `package.json`, and
  `index.js`.

The patches are `config/patches/node-pty@1.1.0.patch` and
`config/patches/@vscode__windows-process-tree@0.8.0.patch`. Root app version and
script metadata are excluded; installed package versions remain owned by the
full lockfile, and the external node-gyp pin belongs to the native action.
A negative control changing only the installer's
pnpm verification condition preserves the native key and paths. Every declared
native input mutation changes the key, and main warming watches those inputs.

This policy creates one cold namespace. The bounded 50-head main sample has
49 adjacent transitions and three native-key changes under both the old and
expanded policies: the added node-pty helper export still invalidates #24448.
There is no measured historical net saving.

The [cold warming run](https://github.com/stablyai/orca/actions/runs/36945655208/attempts/1)
published all four exact Node keys, and its
[warm rerun](https://github.com/stablyai/orca/actions/runs/36945655208/attempts/2)
restored them on fresh runners with the same frozen inputs, Node 24.21.0, and
pnpm 12.0.0. All five jobs passed in both attempts. These times cover the entire
native action: runtime validation, key resolution, restore, any toolchain
recovery, and the unchanged native preparation probes.

| Native Node lane | Cold action | Warm action | Cold post-job save |
| ---------------- | ----------- | ----------- | ------------------ |
| Linux x64        | 18.288 s    | 0.993 s     | 0.387 s            |
| Linux ARM64      | 11.540 s    | 1.062 s     | 1.113 s            |
| Windows x64      | 104.482 s   | 1.381 s     | 2.424 s            |
| Windows ARM64    | 256.662 s   | 3.832 s     | 1.243 s            |

Cold Windows jobs rebuilt all three native addons. Warm jobs loaded and probed
the restored builds; Linux also ran the existing check-only probe before
skipping the external node-gyp installation. Warm post-job steps recognized
their primary keys and did not save again. An earlier trial exposed unavailable
nested composite outputs during post-job saving; both cache variants now use
the same literal path inventory as the requested output, and the fixed cold
jobs published their caches without missing-path warnings.

Both [PR package jobs](https://github.com/stablyai/orca/actions/runs/36945659474)
passed. Windows packaging consumed the same-run Node seed in 1.374 seconds
before its Node tests and Electron transition. Its Electron cache initially
missed while the modules were already healthy, so that stage does not establish
an avoided compilation. Linux's Electron cache was also published, and all 19
bundled native binaries passed the existing glibc floor check.

The [first six-platform headless run](https://github.com/stablyai/orca/actions/runs/36945658897)
ran every persistence lane: five passed, while Mac Intel failed waiting for a
cancel-test worker's ready file before its 500 ms timeout. That lane deliberately
uses `native-runtime: none`; its separate slot build and smoke passed. The failure
blocked the five downstream Linux glibc/musl qualifications, so this run does not
establish complete headless qualification. All six persistence lanes, Node 18
handoffs, and Linux floor/musl gates remain; final qualification is tracked in
the [PR's latest checks](https://github.com/stablyai/orca/pull/24476/checks).

These are single cold/warm observations, not paired medians or a measured
whole-workflow saving. They demonstrate usable exact-key reuse after publication;
future savings depend on cache availability and unchanged native inputs. The
trial seeds belong to this PR's merge ref. Other PRs require a main-branch seed
after merging this new namespace; the existing main-push and scheduled warming
jobs provide that seed.

## Separate mobile install verification: retain the current policy

Three local paired pnpm 12 mobile installs reduced the median from 17.155 to
15.871 seconds, a 1.284-second difference before cache transfer and postinstall
scripts. That narrow margin does not establish a net hosted saving, so the
separate mobile verification record was not adopted.

## Unit shard weights: retain the current allocation

The latest five shard wall times were 526/495/503/508/510 seconds. Reweighting
projected roughly a 4% reduction in the slowest shard without reducing total
CPU work; the evidence across runs was weak. That estimate does not justify
changing allocation, so the current weights remain.

## Serializer oracle allocations: retain the change

The serializer round-trip oracle now reloads one xterm cell per buffer traversal
and writes flag digits directly, avoiding fresh cell objects and flag arrays for
every comparison. Independent replay terminals, cell descriptors, transcript
fixtures, resize schedules, ConPTY modes and seeds remain unchanged.

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/36944080887)
used one Ubuntu 24.04 ARM64 runner, image 20260927.135.1, Node 24.21.0 and one
isolated fork. The baseline formatter was frozen from f69052e. Byte-parity capture
ran separately; these three alternating pairs had no payload instrumentation.
Times cover the complete Vitest invocation, including startup and shutdown.

| Pair/order         | Baseline | Candidate | Change |
| ------------------ | -------- | --------- | ------ |
| 1: baseline first  | 70.631 s | 61.661 s  | -12.7% |
| 2: candidate first | 70.619 s | 62.284 s  | -11.8% |
| 3: baseline first  | 70.750 s | 62.091 s  | -12.2% |
| Median             | 70.631 s | 62.091 s  | -12.1% |

Median test-body time fell from 69.519 to 60.953 seconds. All eight full-cohort
invocations preserved the same 89 passes and two existing conditional skips
across three files. Separate baseline/candidate captures produced identical
95,017,559-byte payloads for all 1,435 scenarios and 7,649 checkpoints, with zero
source crashes; both SHA256 hashes matched the local captures.

Seven focused controls compare against the original allocating oracle, including
all 128 text-flag combinations, styled blanks, wide cells, cell reuse and immutable
snapshots. Five deliberate faults were detected: stale cell contents, a missing
bold flag, changed empty-cell policy, removed scratch reuse and a source-parser
crash. The last control also proved that crash returns enter the capture.

This measures the three-file oracle cohort. Whole-shard timings include other
test bodies, imports and transforms, so a whole-suite saving needs separate
measurement.

## Cache warming: let scheduled ticks wait for active work

The hourly warmer previously cancelled an active warmer, even when both used
the same source. On October 2, the [merge-triggered run](https://github.com/stablyai/orca/actions/runs/36965832780)
at 8ff6296 was interrupted by the [hourly run](https://github.com/stablyai/orca/actions/runs/36966367896)
at the same commit. The Windows ARM dependency installation had run for 356
seconds before cancellation; its native verification was skipped. The other
four lanes had already succeeded.

Scheduled events now wait in the existing concurrency group. Push, PR and manual
events still replace active work. This keeps one active workflow and the default
single pending slot, using GitHub's documented
[conditional cancellation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
All cache probes, platforms and publication rules remain.

This avoids the observed discarded installation. It does not remove the next
scheduled run or its repeated successful lanes, and pending replacement still
applies regardless of the cancellation expression. The bounded 20-run sample
contains this collision; it does not establish a recurring or whole-CI saving.

## Cache warming: six-hour recovery interval

Scheduled warming now runs at 00:41, 06:41, 12:41 and 18:41 UTC instead of hourly.
Main pushes that change cache inputs still seed immediately, and manual dispatch
remains available. All five jobs, probes, keys and publication rules remain.
This removes 20 scheduled workflows and 100 scheduled job starts per day (83%).

Four consecutive October 2 scheduled runs used the same source. The
[18:50 UTC run](https://github.com/stablyai/orca/actions/runs/37050194510) used 474
aggregate runner-seconds across five jobs, including 242 seconds on Windows ARM.
That job restored exact package, verification and native caches; package-store
restore alone took about 70 seconds. Repeating that observed duration twenty
fewer times would avoid about 158 runner-minutes daily, but this one-run estimate
is not a billing forecast or measured post-rollout saving.

The longer interval can delay background repair after eviction or runner-image
changes. Existing consumers retain cold-cache installation/build fallback, and
normal cache reads update last access. Storage was near the repository limit
when audited, so retention and unchanged hit rates are not guaranteed. Observe
misses before reducing the recovery frequency further.

## Daemon shutdown fixture: remove build tools after compilation

The fixture now removes compiler and Python build dependencies, plus npm and
node-gyp caches, in the same Docker layer that installs node-pty. It restores the base image's manual
package marks, keeps procps and util-linux, and retains the packages owning the
shared libraries used by Node and the actually loaded PTY addon. This extends
the [official Node image's package-ownership approach](https://github.com/nodejs/docker-node/blob/main/22/bookworm-slim/Dockerfile)
to native addons. Dependency checks and a real PTY spawn fail the build if cleanup
breaks the runtime.

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/36969120786)
used Ubuntu x64, Docker 28.0.4 and the same resolved Node 22.23.3 base digest for
both images. All 3,418 common entries under `/usr/local` retained their bytes,
modes and symlink targets; all seven resolved runtime libraries matched. Only
two directory-only Python paths disappeared. The 52 removed Debian packages
were build dependencies; retained package versions stayed identical.

| Image payload      | Baseline      | Candidate     | Reduction |
| ------------------ | ------------- | ------------- | --------- |
| Docker archive     | 714,643,456 B | 329,967,616 B | 53.8%     |
| Compressed archive | 205,819,558 B | 91,888,840 B  | 55.4%     |

Each timed arm started a separate Docker daemon with an empty image store,
decompressed the archive, loaded it, rebuilt from its inline cache and ran the
unchanged descendant/canary shutdown check. Every provisioning layer was cached.

| Pair/order         | Baseline | Candidate | Saving  |
| ------------------ | -------- | --------- | ------- |
| 1: baseline first  | 16.320 s | 10.198 s  | 6.122 s |
| 2: candidate first | 16.389 s | 10.141 s  | 6.248 s |
| 3: baseline first  | 16.351 s | 10.223 s  | 6.129 s |
| Median             | 16.351 s | 10.198 s  | 6.153 s |

Median decompression fell from 1.059 to 0.493 seconds and loading from 10.723 to
5.125 seconds. Cached rebuild and shutdown times stayed close. Both seed images
and all six restored consumers passed the original shutdown/canary assertions;
both deliberate no-op disposal controls failed with the descendant still live.
Byte and retained-directory mode faults also failed the inventory comparator.
All six owned daemons stopped gracefully without a forced kill.

These private daemons used separate classic overlay2 stores and the untouched
host containerd service. Production storage settings were not captured, the
filesystem cache was not flushed, and network transfer is excluded. Production
restores overlap dependency installation, so this 37.6% fixture-sequence saving
does not establish a six-second PR wall-time improvement. Single cold image
builds took 19.313 and 22.623 seconds. The Dockerfile change creates one new
fixture key; the existing main warmer seeds it after merge.

## WebRTC egress fixture: avoid GPU initialization for the data channel

The Linux-only probe disables hardware acceleration before Electron readiness.
It still creates two independent processes/profiles, a real data channel, offer
and local description, and checks the exact proxy and UDP policy. The three-second
host observation, 500 ms drain and 20/30/45-second deadlines remain unchanged.

Two fresh Ubuntu x64 runners compared three alternating pairs each, with identical
phase instrumentation. The [first trial](https://github.com/stablyai/orca/actions/runs/36967511524)
started with the baseline; the [second trial](https://github.com/stablyai/orca/actions/runs/36969120786)
started with the candidate. Their first baseline peer constructors took 4.059
and 2.546 seconds and logged the GPU command-buffer error seen in an earlier
package timeout. In the second trial, that baseline delay followed the cold
candidate's 2.3 ms constructor. Every candidate constructor took 2.0–2.6 ms.

Typical process time stayed near 8.3 seconds: baseline/candidate medians were
8.288/8.273 seconds in the first trial and 8.298/8.380 in the reverse trial.
The evidence supports removing an avoidable startup delay, without a measured
typical throughput gain or an estimate of future timeout frequency.

All 12 full case invocations preserved actual unprotected UDP and zero protected
UDP. Both trials rejected seven faults: missing policy, a packet at 2.9 seconds,
a packet during the drain, a missing peer factory or local description, a broken
packet counter and a hung renderer. The original assertions and deadlines caught
each fault. The normal package gate runs the uninstrumented fixture.

## Remote resync fixture: keep coalesced frames in one decoder pass

The first [full PR run](https://github.com/stablyai/orca/actions/runs/36971375340)
passed both package jobs but failed one remote-workspace ordering assertion:
it observed revisions `[2, 3]` where the fixture expected `[3]`. The decoder can
yield between two frames after its four-millisecond work budget. Under slow
scheduling, the first response's promise can publish revision 2 before the
second frame's revision 3 notification is dispatched.

The fixture now holds its delivery clock at the actual timestamp from multiplexer
construction through the first coalesced-buffer delivery, following the existing
decoder test pattern. It restores the clock before asynchronous assertions and
again before disposal. All four source/order cases retain their exact cache,
publication, client-identity and follow-up-read assertions. Production decoding,
its fairness budget and remote messages are unchanged.

Normal focused runs passed all 18 tests. Advancing the clock by four milliseconds
per call reproduced `[2, 3]` in both original response-first cases; the fixed
fixture passed all 18 under the same control. Removing the freeze reproduced both
failures. Bypassing the production read-safety guard still caused `[3, 2]` rollback
in all four ordering cases and eight failing tests overall. All controls preserved
the same 18 test identities. This corrects a reproducible fixture assumption;
one CI failure does not establish a failure-rate reduction.

## Windows server cache metadata: retain the current key

The bounded 50-head main sample ending at 8ff6296 contained no root package
metadata changes. Removing app-version metadata from the Windows server cache
key would not improve reuse in that sample, so the key remains unchanged.

## Windows ARM SSH: prepare the inbox capability during independent builds

The ARM inbox lane starts guarded Windows capability preparation after the pure
provisioning self-test and waits for it before any private SSH server or host cell
runs. Dependency installation and the unchanged native artifacts can run during
that preparation. Preview and x64 lanes keep their existing serial provisioning;
the registered background step completes without mutation in those lanes.

The preparation and the foreground provider use the same installer and isolation
guards. The receipt must match the source, run, attempt, runner, image and native
architecture. The foreground provider still reads the installed capability and
verifies every native binary and Microsoft signature. Account ownership, ACLs,
DefaultShell, private service identity, host cells and cleanup remain independent
checks. A background failure propagates through the unconditional native wait.

Two full four-lane pairs used frozen source refs and the same dependency and
native-install policy. The [first baseline](https://github.com/stablyai/orca/actions/runs/36986929163)
ran before the [first candidate](https://github.com/stablyai/orca/actions/runs/36986970976);
the [second candidate](https://github.com/stablyai/orca/actions/runs/36991232037)
was dispatched before the [second baseline](https://github.com/stablyai/orca/actions/runs/36991234729).
Runner image versions matched within each platform in both pairs.

| Active job, seconds | First baseline | First candidate | Second baseline | Second candidate |
| ------------------- | -------------: | --------------: | --------------: | ---------------: |
| ARM inbox           |          2,403 |           1,644 |           2,353 |            1,667 |
| ARM preview         |          1,002 |             935 |             886 |              872 |
| x64 inbox           |            636 |             732 |             616 |              620 |
| x64 preview         |            562 |             561 |             623 |              566 |

The ARM inbox observations improved by 759 and 686 seconds. Baseline dependency
installation and artifact builds consumed 501 and 498 seconds before capability
installation could start. Candidate capability installation ran during that
work, but also took about 261 and 232 seconds less than the baseline. Candidate
dependency installation was slower, particularly in the second pair. These
observations support overlap on ARM; they do not establish a guaranteed 11–13
minute saving, a reduction in queue time, or the cause of installer variability.
The x64 lane showed no repeatable gain, so it keeps serial preparation.

All 16 actual Windows providers and 48 host-cell verdicts passed across the two
pairs. Receipts verify native machine identity, private service absence, owned
process exit, account removal and key removal. Loaded profile disposition remains
separate from those required cleanup checks. Hosted execution also verified the
native background/wait syntax; older actionlint versions do not recognize it.

### Overlap the private profile observation budgets

After service deletion and owned process exit, profile cleanup polls each owned
SID with its own full 30-second monotonic budget. Independent budgets now run
together. Every deletion follows a fresh targeted read; loaded profiles remain
for disposable VM destruction. Service identity, PID ownership, process exit,
account removal and key removal still fail the complete provider on error.

The maintained diagnostics self-test executes the actual cleanup try/catch with
scoped Windows API and clock controls. Eight positive cases cover full windows,
late unload, reload, query overhead, mixed states and missing SIDs; ten specific
failure cases cover foreign profiles and the required cleanup gates. Disposable
shortened-deadline and stale-snapshot mutations fail those controls. A separate
mocked real-clock observation took 30.179 seconds for three loaded profiles,
compared with about 90 seconds for serial full budgets. This measures polling,
not an actual Windows provider or the entire job.

The third profile no longer gains incidental extra time while earlier profiles
consume their budgets. A profile unloading at 45 seconds may therefore remain
where serial cleanup removed it. This uses the existing disposable-VM fallback;
it does not remove a loaded profile or relax mandatory account/key cleanup.
Hosted qualification of the combined workflow remains pending.

## Coordinator mail tests: advance observation windows without removing them

Six cases advance their original six 1,500 ms and ten 100 ms observation windows
with a scoped clock. Real filesystem, SQLite, journal, RPC and runtime work still
finishes asynchronously. The original journal-read gate and all counter and
operation assertions remain. Cancellation during delayed startup and the
Date-only age case retain real timers. Teardown stops the host and closes the
database before advancing the known 2,000 ms orphan repair, then asserts no fake
timers remain and restores the clock in `finally`.

Two opposite-order local pairs passed the same 23 cases and unchanged source
hashes. Selected-case totals fell from 13.674 to 3.318 seconds and from 13.276 to
6.323 seconds. Whole-file test totals fell from 24.845 to 10.829 seconds and from
21.500 to 19.410 seconds. Process wall times were 41.488/37.810 seconds and
42.140/78.450 seconds; the reverse candidate spent 56.31 seconds importing under
unrelated local load. Local process-wall savings were inconclusive.

The later [hosted x64 and ARM comparison](https://github.com/stablyai/orca/actions/runs/37001891871)
passed the same 23 cases in `structured-chat-coordinator-mail.test.ts` in both
orders on each architecture, with frozen case and policy hashes. Median full-file
wall time was 33.506 → 23.149 seconds on x64 and 33.438 → 22.504 seconds on ARM.
Median test-body totals were 19.329 → 9.343 and 19.695 → 9.103 seconds, respectively.
These measurements qualify this file; they do not measure whole-PR time.

Injected extra deliveries at 1,499 ms and 99 ms still fail the original assertions
in both clock modes. The latter candidate fails the unchanged journal-read gate
with the same extra provider start. A separate control confirms the orphan repair
actually executes against the closed database and leaves no fake timers. The
change retains all 121 original expectation sites and adds one teardown check;
it does not shorten the runtime's observation interval or claim a whole-PR gain.

## Stub child shutdown clocks: Codex and Claude

[Merged Codex change #24893](https://github.com/stablyai/orca/pull/24893) scopes timeout
clocks to two synthetic-child cases in `codex-app-server-connection.test.ts`.
The full platform graceful deadline and 1,000 ms forced wait remain; the test
waits for the actual stub SIGKILL before advancing the forced window. Streams,
process-table reads, Date and immediate callbacks remain real. Fault controls
still detect late exit, missing EPIPE, missing exit proof and unwanted notification.

The [hosted ARM comparison](https://github.com/stablyai/orca/actions/runs/37074124526)
passed the same 32 full-file cases in baseline/candidate and candidate/baseline
order. File wall times were 13.671 / 13.674 seconds originally and 1.658 / 1.649
seconds with scoped clocks. Installer time is excluded; generated caches remain
across the disclosed order. Real-child coverage and production shutdown code remain.

[Merged Claude change #24897](https://github.com/stablyai/orca/pull/24897) changes only
two synthetic-child cases in `claude-agent-sdk-exit-proof.test.ts`. Both full
33-case runs passed, including the unchanged five real-child cases. In one local
macOS pair, the two bodies took 2,503 / 1,502 ms originally and 1.37 / 0.39 ms with
scoped clocks. They cross a real immediate callback before advancing the complete
1,500 ms graceful and 1,000 ms forced windows, restore timers in `finally`, and
retain the original false exit verdicts. Fault controls detect either deadline
shortened by one millisecond, an unproved true verdict and a leftover timer.
[Normal PR CI](https://github.com/stablyai/orca/actions/runs/37075819218) passed;
these local body measurements do not establish hosted or whole-PR time savings.

## Sequential static analysis and typecheck: retain separate jobs

The earlier recommendation below is superseded by [October 4 shared PR preflight capacity](#october-4-shared-pr-preflight-capacity).

A four-trial hosted screen kept the slim router unchanged and compared the two
independent ARM jobs with one ARM job running their unchanged checks sequentially.
The [compiler/planner census](https://github.com/stablyai/orca/actions/runs/37069472888)
matched all compiler inputs and the full 10,477-file unit inventory in separate,
shared root-only and shared mixed-install states. The [safety qualification](https://github.com/stablyai/orca/actions/runs/37075043747)
verified native joins after compiler failure and a real late action-post failure;
all four guarded downstream sentinels skipped and the audit passed.

| Trial                                                          | Mode     | Active ARM seconds | Router finish to heavy finish, seconds |
| -------------------------------------------------------------- | -------- | -----------------: | -------------------------------------: |
| [1](https://github.com/stablyai/orca/actions/runs/37075574191) | Separate |                157 |                                    124 |
| [2](https://github.com/stablyai/orca/actions/runs/37075887937) | Combined |                134 |                                    150 |
| [3](https://github.com/stablyai/orca/actions/runs/37076222202) | Combined |                129 |                                    134 |
| [4](https://github.com/stablyai/orca/actions/runs/37076786281) | Separate |                159 |                                    194 |

Both pairs saved active ARM time: 23 and 30 seconds, or 14.6% and 18.9%, with one
heavy admission instead of two. The active critical path was 15 and 8 seconds
longer. Downstream eligibility changed by +26 and −60 seconds; observed ready-to-start
delay differences of +11 and −68 seconds explain that reversal. Created-to-start
delay is recorded separately and does not establish a quota or queue cause.

Retain separate jobs for now. This screen shows a capacity saving, with a longer
active critical path and no repeatable latency gain. All trials used frozen
`cc73c8e1a72b0e9ee9c29e57458ce307f5f019c2` source, manual workflow dispatches,
Node 24.21.0 and the same four exact primary cache hits. Main's later
[Linux PR root-store policy change #24896](https://github.com/stablyai/orca/pull/24896)
is outside this screen. The trial ran actual heavy checks and proved unit and both
package eligibility, without launching those downstream matrices or measuring a
whole-PR speedup.

## Linux headless runtime build overlap

The historical pinned Bun artifact now builds in a native background step while
current native preparation and Node bundling run in the foreground. An
unconditional join precedes the unchanged artifact and cross-runtime tests. Bun
setup stays Linux-only; other platforms register and join a successful no-op.
The producer publishes step outputs consumed only by those tests. The existing
selector, native floors, template builders and cache policies remain.

A [hosted alternating comparison](https://github.com/stablyai/orca/actions/runs/37072923774)
ran four serial/overlap arms on each of two Linux VMs:

| Architecture | Serial preparation, seconds | Overlapped preparation, seconds |
| ------------ | --------------------------: | ------------------------------: |
| x64          |             20.831 / 19.576 |                 11.149 / 10.914 |
| ARM64        |             15.155 / 14.396 |                   8.566 / 8.553 |

Every arm passed the same 961 cases across 92 files: 930 passed and 31 skipped.
Both cross-runtime persistence cases passed. The two live daemon-handover cases
kept their existing protocol-version skips. All four x64 arms passed actual Node
18 loading and pinned-runtime handoff. Installed/source inputs and artifact
inventories matched; each normal owned-process ledger was clean before cleanup.
Common native compiler warmup preceded timing and retained its generated Python
caches in the strict installed ledger. These are preparation savings of 5.8–9.7
seconds, excluding setup, cold installs, runner start delays and whole-PR time.

Actual [Bun failure](https://github.com/stablyai/orca/actions/runs/37078015921) and
[Node failure](https://github.com/stablyai/orca/actions/runs/37078021568) controls
qualified genuine compiler errors with fresh live opposite builders, native joins,
skipped consumers, restored inputs and verified exits. A [normal cancellation
control](https://github.com/stablyai/orca/actions/runs/37079655167) received SIGINT
while the actual Bun builder was freshly live; both builders and the detached
owned child had simultaneous earlier readiness. All three native joins had terminal dispositions of cancelled, success and
cancelled, and every consumer skipped. The temporary observer retired its owned processes;
the collector independently verified their absence and unchanged inputs. This
proves signal delivery and observer-owned retirement, without establishing
runner-only descendant cleanup at the join. The unchanged historical builder
starts finite build/smoke work, and its children retain GitHub's normal orphan
tracking marker.

Earlier cancellation trials remain excluded from live-build qualification: one
collector stopped its observer before signal routing, and the corrected trial
received the signal after both builders finished. The qualifying trial requested
normal cancellation earlier in the same preparation sequence to account for
observed delivery delay; no workload, wait or proof predicate was shortened.

## October 3 Terminal Perf dependency preparation

The daily/manual Terminal Perf workflow still installed current dependencies through
raw lifecycle scripts and a global node-gyp installation. Its historical `ref`
input also accepts revisions that lack the shared installer, so replacing that
path unconditionally would break older runs. The current-profile path now uses
the existing shared installer with explicit Electron preparation and archive
caching. A guard requires GitHub-hosted Linux x64, Node 24/pnpm 12.8.1, the
native-only root postinstall and the needed local action inputs/files. Other
profiles and historical revisions keep their original frozen install.

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/37101695800)
ran both preparation paths in each of two Linux x64 jobs, reversing their order.
Legacy/shared preparation took 25.164/16.956 seconds and 27.434/18.032 seconds:
8.208 and 9.402 seconds saved. Both used Node 24.21.0, pnpm 12.8.1 and Electron
43.7.5. Both shared native-module cache lookups missed, so this improvement did
not depend on a warm native build. Electron archive and root pnpm cache lookups
hit. Dependency trees, pnpm data and Electron archives were reset between paths;
compiler headers and external services were not. Bootstrap, resets, validation,
post-job cleanup, queueing and the production guard step are outside those times.
These are preparation measurements, not whole-workflow or billing savings.

Both paths passed a native-module probe inside the actual Electron executable
with `ELECTRON_RUN_AS_NODE=1`, and built the same Electron-vite e2e application.
The candidate's 18 focused routing/fallback tests, workflow actionlint and changed
code-quality checks passed. Performance tests, budgets and report uploads remain
unchanged. The [existing October 2 run](https://github.com/stablyai/orca/actions/runs/36985792125)
failed the same-workspace 50/100-terminal budgets (46.9/50.2 ms against 25 ms).
This dependency change does not claim to resolve those application regressions.

The [full candidate integration](https://github.com/stablyai/orca/actions/runs/37104625474)
passed on `df71ad849cd854a232f7063562785563743b641a`: current preparation was
selected, its native cache missed and rebuilt, the app built and all 32 report
annotation rows passed the unchanged budget checker. The downloaded report also
passed the same checker locally. This is integration evidence; it does not
attribute application latency changes to dependency preparation. Subsequent
rebases resolved report documentation and incorporated fixture teardown fixes.
Workflow, installer-action and toolchain content stayed unchanged. Main also
added an import and a Windows-only MSBuild setting to the native-runtime script:
the imported helper has no top-level side effects, and the Linux rebuild branch
is unchanged. Focused tests verify its Linux/macOS no-op behavior. Final-head PR
checks qualify separately.

## October 4 reusable cells for terminal context scans

Terminal cursor-context scans now request one reusable cell per invocation when
the adapter offers getNullCell, and pass it through all unchanged text/style
scans. Adapters without that optional method keep the existing allocating path.
The scratch cell is local and no cell reference escapes into returned context.
Browser composer/readiness text, colors, bold flags and wrapping are unchanged.

Three alternating one-worker ARM pairs in
[37182789677](https://github.com/stablyai/orca/actions/runs/37182789677)
ran all 19 original cases from readiness census suite 2. Baseline complete
invocations were 37.141 / 37.879 / 37.090 seconds; candidate invocations were
33.887 / 33.387 / 32.916 seconds. Median 37.141 to 33.387 seconds saves 10.1%.
This is a focused workload measurement, not a whole-shard or queue-delay claim.

Separate baseline/candidate captures retained all 192 cases across six census
suites. Every context and visible projection matched: 643,926 of each, with
7,465,308,324 complete length-prefixed payload bytes hashed per test/type/order.
The canonical capture digest was
`f7440c0f1b5bbb57127cd29245530029415c8e9e243c1744359f330b3c7ace19`.
These captures run outside the timing samples. All 41 cursor/composer/browser
consumer checks passed. Seven faults for lost dim filtering, wide continuation,
bold prompt, custom foreground, wrap preservation, adapter fallback and scratch
reuse failed their intended assertions. Node and web typecheck, lint and format
passed. Two added controls prove per-call scratch lifetime and adapter parity.

## October 3 producer follow-up: automatic selection for the measured profile

The first producer rollout in [#24927](https://github.com/stablyai/orca/pull/24927)
passed all 46 PR checks, all five manual warmers and all 11 manual Headless
qualifications on `a2c489c0cca5e46d24333a4d40ba910af0de0208`. The same root installer
also serves recurring unit, browser and performance workflows that had not opted
in. The follow-up defaults the existing input to `auto`, reusing lookup mode for
non-PR root-only installs on GitHub-hosted Linux/macOS/Windows x64/ARM64 runners,
with no job container, the manifest's Node 24/pnpm 12.8.1 profile and no conflicting
Node override. Explicit `true` and `false` retain their previous meanings. Mixed
lockfiles, other toolchains, containers and self-hosted runners retain full cache
restoration; PR policies are unchanged. The manifest check runs only when the
context is potentially eligible, before setup-node chooses its cache behavior.

A second cleanup audit distinguished nesting depth. The
[twice-nested control](https://github.com/stablyai/orca/actions/runs/37087090689)
published the environment-path payload and lost the output-path payload with an
`Input required and not supplied: path` warning. The
[direct control](https://github.com/stablyai/orca/actions/runs/37087211236) published
and restored both payloads. Current Electron archive callers are direct, so they
need no cache-path change. Keeping the producer's exported path also makes its
new lookup mode safe for callers that nest the shared installer. These tiny
controls establish publication behavior, not installer time savings.

The [actual automatic-mode cold publisher control](https://github.com/stablyai/orca/actions/runs/37097980789)
passed both jobs on `7b8858bdc8f`. A twice-nested wrapper called the installer
without overriding its default input. The writer selected lookup, missed its
unique root-lockfile key, completed the frozen policy-checked install and saved
that key during cleanup. A fresh reader restored the exact key and installed the
same dependency successfully. The fixture retained the manifest toolchain and
applicable workspace policies; its one dependency keeps the publication check
small. Two earlier trials failed fixture assertions (the pnpm multi-document
header placement, then its empty cache-miss output), and are excluded. This proves
automatic selection and cold publication, not a new timing result. Local
verification passed eight suites / 184 tests, the changed-code quality gate and
compiled-composite actionlint.

## October 4 shared PR preflight capacity

Static analysis and the unchanged compiler now share one ARM runner and guarded
Node 24 install. Static checks finish and all background work joins before the
compiler starts; unit planning still overlaps compilation. Each phase keeps its
classifier output. Successful no-op background bodies register every required
join when a phase is unselected or an earlier step failed. Unit and package
consumers depend on physical job success, including action cleanup.

Three counterbalanced pairs in
[37180613601](https://github.com/stablyai/orca/actions/runs/37180613601)
used the same frozen checkout `f199a20c3acd`, Node 24.21.0, pnpm 12.8.1,
policy hashes, native cache hits, warm TypeScript cache and 10,787-file unit plan.
Both arms used the PR root-only download-store policy. Total active job time was
152 / 153 / 151 seconds separately and 138 / 133 / 129 combined. Excluding the
extra measurement-only evidence steps gives 151 / 151 / 149 versus
136 / 132 / 128 seconds: median 151 to 132, saving 19 seconds (12.6%).
Two heavy runner admissions become one. This saves capacity; it does not prove a
whole-PR latency or queue gain. The median active dependency barrier increases
from 116 to 132 seconds because compilation follows static checks.

The separate physical-failure run
[37180755694](https://github.com/stablyai/orca/actions/runs/37180755694)
proved that an included TypeScript error failed the actual compiler, its planner
still joined, and unit/package admissions skipped. A registered late action post
failure also blocked both consumers after successful foreground checks and
published shards. All 12 unselected/prior-failure no-op backgrounds joined, and
the downstream audit passed. Local workflow contracts passed 239 tests across
12 suites; lint and formatting passed.

## October 3 retired-cache collection observation

The same owner-collection assertion failed in unit shard 3 of
[37098089274](https://github.com/stablyai/orca/actions/runs/37098089274/attempts/1)
and [37100365037](https://github.com/stablyai/orca/actions/runs/37100365037/attempts/1),
requiring a full shard retry despite the focused suite passing locally. Its
three-turn collection budget was shorter than the six-turn plus final yield
pattern already used by the GitLab known-host retirement tests.

The fixture now uses that existing observation budget. All seven tests, their assertions,
expiry clocks and production code are unchanged. The focused suite passes. A
local fault control changed only the production timer callback to hold its owner
strongly: the owner-collection assertion failed, with the other six tests passing.
The source was restored afterward. Extra collection turns therefore preserve the
strong-retention oracle. Hosted qualification is still required; these observations
do not prove a particular VM-retention cause or quantify avoided retries.

## October 4 terminal oracle execution

Three measured test-support changes preserve the original seeds, payloads,
chunk boundaries and meaningful assertions. Serializer comparisons reuse cells
and format only the first mismatch instead of allocating descriptors for every
cell. The terminal parity writer submits every original chunk in FIFO order and
awaits the final parser callback. The independent legacy frame oracle memoizes
measured code-point widths. Its discarded algebra-only case never called
production and still passed when production always threw.

Three alternating one-worker hosted ARM pairs measured complete invocations:

| Cohort                                   | Baseline median | Candidate median | Saving |
| ---------------------------------------- | --------------- | ---------------- | ------ |
| Serializer replay/fuzz/descriptor checks | 71.675s         | 46.581s          | 35.0%  |
| Emulator/reconciliation/color parity     | 24.095s         | 5.411s           | 77.5%  |
| Frame equivalence                        | 18.472s         | 13.736s          | 25.6%  |

[37180517143](https://github.com/stablyai/orca/actions/runs/37180517143)
retained 116 timed serializer passes and three existing/paired-control skips.
Separate captures matched all 190,796,645 raw bytes over 1,611 scenarios and
8,617 checkpoints (SHA256 `00ab219cfb31456af2ecd5e766d1b82d47abc751f6f2de0d7f795e36a936d3c7`),
including complete outputs and diagnostic payloads. Twenty candidate controls
passed; formatting/color/blank/clipping fault controls detected regressions.

[37181073275](https://github.com/stablyai/orca/actions/runs/37181073275)
retained all 16 parity cases and default fuzz counts. Captures matched 2,325
batches, 28,182 original chunks and 1,698,285 input bytes, with identical
terminal state and serialization per terminal/batch. Independent terminal
completion order differs, so comparison uses canonical per-terminal ordering
(SHA256 `c38ac1dbbefb9f6dc33ecfe7c495d65b707c1664614544622af93cfc1850e421`).
All 73 callback/parser/other-consumer controls passed; first-callback, reversed
chunks, missing empty boundary and early-completion faults failed.

The frame candidate passed all 19 retained cases directly against the original
uncached legacy oracle, preserving 4,000 short and 800 near-cap seeded trials.
Sequence, surrogate width, byte width and span-transform faults failed real
assertions. A part-array alternative was rejected after adding time locally.
Hosted Node typecheck passed. These are focused workload savings, not measured
whole-shard or queue-delay improvements; application behavior is unchanged.

## October 3 unit-selection evidence: include failed references

The caller's `needs.test.result == 'success'` condition prevented the advisory
collector from reading failed unit runs, despite the reviewer's existing support
for failed tests. A six-run screen from the October 3 occupancy sample found only
one review artifact; it was a full fallback, so it did not validate selection.
Missing artifacts cannot establish that selection catches red tests.

The caller now permits both success and failure while excluding cancellation and
skipped tests. The collector remains advisory and absent from `verify` dependencies.
Incomplete, interrupted or inconsistent shard records still cannot become complete
reference evidence. Existing omitted-failure tests preserve that negative control.

The five artifacts from failed [run 37098089274, attempt 1](https://github.com/stablyai/orca/actions/runs/37098089274/attempts/1)
were reviewed locally using the unchanged script. It recognized a complete failed
reference covering 10,606 files and 9,270,307 worker-ms. Its candidate was the full
fallback, so `selectionEvaluated` remained false and no selection promotion is
justified by this control. Focused workflow/reviewer checks passed 24 tests,
including actual caller-expression outcomes for success, failure, skipped and
cancelled states. This repair supplies needed evidence for a later optimization;
it claims no runner-time savings and does not enable selected tests.

The updated caller also passed the hosted red-run control in
[37100365037](https://github.com/stablyai/orca/actions/runs/37100365037).
The collector succeeded after one unit shard failed, while required verification
remained red. Its review recognized all five shards as a complete reference
(10,608 files, 8,965,977 worker-ms). This was again a full fallback with
`selectionEvaluated: false`, not evidence for enabling selected tests.

## October 4 runtime imports and recovery fixtures

Three helper-only tests now import the existing terminal modules directly rather
than initializing the runtime service. Ten copied-loop cases never exercised
runtime memoization: they passed with its cache, timestamp update or prune
invalidation disabled. Two actual helper checks remain. The existing runtime
prune suite now exercises real leaf cache reuse, split prompt timestamps,
ordinary output, fresh prompts and detection after retained-history eviction.
Each of those three production faults fails a real runtime assertion.

Recovery tests now seed three exact fixture variants once, after the seed child
has closed. Each crash still receives an independent byte-for-byte copy of the
entire database/WAL family and remapped paths. Buffer.equals retains exact byte
comparison without recursive matcher overhead. All 46 original crash boundaries
and retries remain. Four additional copy-isolation/WAL checks run, and teardown
requires that all seed bytes remain unchanged after the full suite.

Three alternating one-worker hosted ARM pairs in
[37182181976](https://github.com/stablyai/orca/actions/runs/37182181976)
measured these complete invocations:

| Cohort                            | Baseline seconds         | Candidate seconds        | Median saving |
| --------------------------------- | ------------------------ | ------------------------ | ------------- |
| Three imports only, same 15 tests | 19.257 / 19.167 / 19.363 | 1.769 / 1.768 / 1.768    | 90.8%         |
| Final four-file runtime cohort    | 22.312 / 22.122 / 21.969 | 13.494 / 13.793 / 13.601 | 38.5%         |
| Recovery crash boundaries         | 24.082 / 24.075 / 24.814 | 8.061 / 8.105 / 9.074    | 66.3%         |

The final runtime cohort has seven real cases versus 16 including the copied
loops; its new runtime case is included in candidate timing. Recovery has 50
passes versus the original 46. Hosted Node typecheck passed. Recovery faults for
last-byte database/WAL corruption, shared database paths, missing WAL copies and
accepted/unaccepted seed collision failed the intended assertions. These are
focused workload savings, not measured whole-shard or queue-delay gains.

An independent local cache screen left both caches disabled. Across 14 unchanged
files and 92 cases, a warm Vitest transform cache reduced median invocation time
3.090 to 1.948 seconds, excluding archive costs; its cold arm increased time to
3.281 seconds. Node compilation caching showed no gain. Controls reproduced stale
transforms after TypeScript configuration or plugin-option changes, so persisted
reuse requires a complete transform-input stamp and hosted net-cost evidence.
A separate 130,000-pane leaf-collection optimization was restored: its complete
migration-file timing stayed within noise. The regression fixture remains.

## October 3 removal fixture cleanup ordering

[37105566358](https://github.com/stablyai/orca/actions/runs/37105566358)
failed unit shard 4 with `ENOTEMPTY` removing the failed-removal fixture's temporary
directory; the other four shards passed. A client's removal reply intentionally
precedes the detached job's final record persistence. This fixture reset tracking
and removed the directory before waiting for that persistence, allowing a writer
to race cleanup. Its teardown now awaits the existing settlement helper before
resetting tracking or deleting the fixture. Production removal behavior and all
assertions are unchanged.

All 1,348 runtime tests passed (one existing skip). A temporary controlled queue
held the final record write after the client replied: waiting before reset stayed
pending and passed; resetting before waiting lost the tracked job and failed the
same ordering assertion. The gate was released, both controls drained the captured
job, and the instrumentation was removed. Changed-code quality passed. This proves
the teardown ordering mechanism, not a measured avoided-retry saving. Final-head
hosted qualification remains required.

## October 4 store oracle and retention fixtures

The randomized in-place-store test validated the copying oracle twice after
accepted mutations and compared snapshots through the same production parser.
Its 5,000-step retention fixture generated enough tombstones to hit the count
limit, but never reached the 4,096-revision age boundary.

The test retains all four seeds and 1,500 mutations per seed, removes the duplicate
validation, and projects snapshots directly from the copying oracle's validated
maps. Separate fixtures now check the revision before, at and after expiry and
count overflow. Production code is unchanged.

Three alternating one-worker pairs on `ubuntu-24.04-arm` in
[37180517143](https://github.com/stablyai/orca/actions/runs/37180517143)
measured baseline invocation times 33.551 / 33.304 / 33.529 seconds and candidate
13.848 / 13.816 / 13.875 seconds: median 33.529 to 13.848 seconds, saving 19.681
seconds (58.7%). Baseline passed seven tests; candidate passed eight. This is a
focused test saving, not a measured whole-shard or queue-delay change.

Hosted Node typecheck passed. Separate fault controls failed the intended
assertion for early, late and disabled age expiry, disabled count compaction,
and a snapshot that drops child descriptions. The description fault passes with
the original parser-sharing oracle and fails with the independent projection.

## October 4 Git contention and remaining readiness waits

The full Git admission benchmark compared a disabled arm with no correctness
assertions to an enabled arm with structural ledger checks. Its default CI test
now saturates the real base and headroom budgets with FIFO-gated child processes,
queues older background and newer interactive work, releases base slots, and
requires interactive priority, matching outputs and complete permit release.
The full original diagnostic remains opt-in through
`ORCA_GIT_ADMISSION_STORM_MEASUREMENT=1`; both opt-in tests passed locally.
The existing Windows real-Git parity tests remain unchanged; this fixture retains
its existing POSIX platform scope.

Two remaining Antigravity transcript tests used real 5,000ms refusal windows.
They now use the existing scoped `waitForTranscriptIdle` timer harness after the
emulator drains. All 60 tests, original captured transcripts, deadlines and
readiness assertions remain.

Three alternating one-worker hosted ARM pairs in
[37180614492](https://github.com/stablyai/orca/actions/runs/37180614492)
measured these complete focused invocations:

| Suite                 | Baseline seconds         | Candidate seconds        | Median saving   |
| --------------------- | ------------------------ | ------------------------ | --------------- |
| Git admission storm   | 26.619 / 26.635 / 26.582 | 1.017 / 1.018 / 1.016    | 25.602s (96.2%) |
| Antigravity readiness | 27.347 / 27.910 / 27.550 | 13.855 / 13.894 / 13.800 | 13.695s (49.7%) |

Each candidate passed its original meaningful checks. Hosted Node typecheck
passed. Separate scheduler faults for bypassed admission, withheld release and
FIFO-only priority failed the queued-contention or interactive-start assertion.
Two additional local transcript faults failed the original picker-rejection and
repaint-readiness assertions. These are focused suite savings; whole-shard time
and queue delay were not measured by this experiment.

## October 4 aggregate unit-test comparison

A [counterbalanced hosted comparison](https://github.com/stablyai/orca/actions/runs/37197643399)
measured 128.605 seconds less summed test-process time (4.36%) and a 37.694-second
reduction in the slowest shard (5.98%). It compares the accepted optimizations
with their original file snapshots on the same source, five fixed shard
assignments, Node 24, Ubuntu ARM and four workers per process. This is one paired
trial, not a population estimate or a measurement of PR queue delay.

| Test process                  | Original snapshots | Accepted optimizations |
| ----------------------------- | ------------------ | ---------------------- |
| Shard 1                       | 574.221s           | 533.116s               |
| Shard 2                       | 572.553s           | 569.593s               |
| Shard 3                       | 630.629s           | 592.935s               |
| Shard 4                       | 565.412s           | 546.759s               |
| Shard 5                       | 609.410s           | 581.218s               |
| Sum: runner time during tests | 2952.225s          | 2823.621s              |
| Maximum: test critical path   | 630.629s           | 592.935s               |

Both arms cover exactly 10,838 timed modules on source `9574c8adb253` and tree
`4d5487e8b827`. One added eight-case batching qualification passes in a separate
0.770-second invocation outside the table, completing the 10,839-module ordinary
census. The complete timed case and outcome
comparison accounts for eight approved coverage changes: 105,231 original cases
versus 105,242 candidate cases. Removed copied simulations and an algebra-only
case are accompanied by real runtime, retention, recovery and reusable-cell
regressions. No unexpected case or outcome difference is accepted.

Each arm starts with distinct empty transform and result caches; Node compilation
caching is disabled. Cold-cache execution ordering remains Vitest's default and
can change with source size. Source snapshots, assignments, raw reports and case outcomes
are checked. Only three case-title fields containing random temporary paths or
a UUID use stable identities, bound to the exact two test-source hashes; raw
titles remain in the artifacts.

The five dependency setups total 84.284 seconds and are shared by both arms.
The actual paired jobs consumed 5,969 seconds and spanned 2,031 seconds from the
first start to the last completion. Those job figures include both treatments,
setup, uploads and staggered starts; they cannot be assigned to either arm or
used as a workflow saving. The table measures test-process wall time, not CPU
time or the complete CI workflow. Focused-suite percentages elsewhere in this
report are separate measurements and must not be summed into these results.

The [earlier aggregate trial](https://github.com/stablyai/orca/actions/runs/37193799646)
is rejected because a real test failed; its timings do not qualify a gain. Two
local invocations sharing one XDG directory reproduced the Muse refresher failure.
The fixture now isolates and restores that setting in both arms. The historical
serializer case ledger was also independently corrected from the original source
before this fresh trial; its seven original cases and twenty candidate cases are
an explicit coverage change rather than an assumed equal census.

## October 4 shard-weight holdouts

Fresh shard weights were generated with the production importer from a complete
successful run of the accepted source. Two subsequent hosted holdouts used those
same weights and assignments without retraining. The
[first pair](https://github.com/stablyai/orca/actions/runs/37199891967) alternated
existing and fresh assignments across the five jobs; the
[second pair](https://github.com/stablyai/orca/actions/runs/37201939057) reversed
each job's treatment order.

| Test-process measurement | First: existing | First: fresh | Reversed: existing | Reversed: fresh |
| ------------------------ | --------------- | ------------ | ------------------ | --------------- |
| Sum across five shards   | 2813.595s       | 2776.421s    | 2924.689s          | 2878.481s       |
| Maximum shard wall       | 578.735s        | 584.709s     | 603.995s           | 614.408s        |

Fresh weights reduced summed test-process time by 1.32% and 1.58%, but increased
the slowest shard's time by 1.03% and 1.72%. The small capacity saving comes with
a repeated critical-path regression, so the existing weights remain. The 3.01%
improvement projected from training module durations is not a measured speed
gain.

Every arm covers the same 10,839 modules and 105,250 case outcomes on source
`9574c8adb253`, tree `4d5487e8b827`, Node 24.21.0, Ubuntu ARM and four workers.
Both trials use cold caches and the same training data, weights, plans and case
identity rules. Complete raw reports, assignments, hashes and opposite treatment
orders are checked before combining the results. Two pairs supply no statistical
confidence or account-wide queue measurement. The second run's jobs started 119
seconds apart; that stagger and the paired jobs' setup and upload costs are
separate from the treatment timings above.

## October 4 remaining unit-test opportunities

The audit retained real child-process, PTY, SSH and crash-boundary tests. It
removed copied simulations or algebra-only cases after fault controls showed
that they could pass with production behavior broken. The retained or replacement
tests exercise production behavior directly. The focused timings in this report
use the final qualified checks. They must not be added together to estimate a
whole-workflow saving.

Several further changes did not justify promotion:

- A synchronous readiness-clock screen retained all 49 shard cases and their
  outcomes, but complete invocation time changed only from 34.210 to 33.518
  seconds in one local pair. That 2% result was too small to ship without a
  stronger result; the original implementation remains.
- A larger local transform-cache screen reduced warm test execution. Separately
  measured medians for warm tests (17.251 seconds), extraction (3.539 seconds) and
  archive creation (3.092 seconds) sum to 23.882 seconds, versus 23.473 seconds
  with caching disabled. This component estimate excludes transfer costs; it is not an
  end-to-end measurement. Unkeyed plugin options, inherited configuration and
  import priority also produced stale reuse. Persisted test transforms remain
  disabled.
- Two successful full-run shadow references identified about 1.9% of
  recorded worker time as omittable. That is advisory worker time, not measured
  runner occupancy. It does not supply the failed-reference evidence or a
  complete selected-run comparison needed to enable test selection.
- Six sampled failed PR runs contained no failed unit job that could trigger
  unit-matrix fail-fast. Successful unit siblings of failures in other jobs
  cannot be counted as savings from that policy. The sample is too small to
  establish a population-wide rate, and the policy remains unchanged.

These screens reject the examined changes; they do not establish that every
future optimization is exhausted. Shorter admitted jobs and one shared preflight
reduce demand on the existing runner allowance. They do not increase that
allowance or prove lower queue delay under different account traffic.

## October 5 remaining import, diagnostic and checkout work

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/37247027814)
used three alternating pairs per treatment at source
`b18b174cd463f852051dc22adc8478b82dee4d1f`. Focused tests ran as fresh one-worker
processes on the four-core, 16 GB Linux ARM runner with Node 24.21.0, pnpm 12.8.1
and Vitest 4.1.11; persisted transforms and Node compile caches were disabled.

| Work                                              | Original median | Candidate median | Median paired saving |
| ------------------------------------------------- | --------------- | ---------------- | -------------------- |
| Real incumbent-process test file                  | 16.478s         | 5.976s           | 10.520s              |
| Commentable-line lifecycle test file              | 9.595s          | 6.880s           | 2.714s               |
| Agent-status diagnostic plus semantic test cohort | 11.547s         | 8.235s           | 3.361s               |
| Windows x64 SSH checkout                          | 22.052s         | 16.884s          | 5.020s               |
| Windows ARM SSH checkout                          | 46.758s         | 33.910s          | 13.456s              |

The incumbent cases own distinct sockets, shim directories and process groups.
Running them concurrently preserves all nine outcomes and every real five-second
lsof deadline. Both original and candidate still reject an unreaped helper and
false claims of clean enumeration. Fault receipts prove the actual modified probe
was imported and all owned helpers, groups, sockets and directories were cleaned.
The Windows platform gate retains all nine skips.

The renderer lifecycle tests keep their six original bodies and real decorator,
zone and model behavior. Only the unrelated saved-note delivery menu is replaced
by a typed throwing facade. Its cleanup assertion rejects unexpected use. Actual
faults in memoization, value-equal refreshes and model replacement still fail their
original assertions; a real menu call fails the facade and the cleanup guard.

The agent-status benchmark reports counters and timings but asserts only a
nonempty status map and positive elapsed time. It remains available through
`ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.agent-status-benchmark.config.ts`.
Ordinary discovery removes exactly that reporting test. Its 15 meaningful routing,
index-retention and batch cases remain unchanged. Three real production faults
pass the old reporting test and fail those retained contracts. Manual execution
preserves its JSON schema and all nine deterministic counters at 423 worktrees,
634 tabs and 1,000 events.

Windows SSH hosts retain complete main, shared, relay, type, configuration,
native, resource and test trees, plus root files. Six actual checkouts per
architecture pinned candidate source `ce69b84d675b0a8b4763b03329c9d6549ac723f1`;
all 16,568 retained files match the full checkout's contents, modes and index.
The original 5,209 required inputs and six further inputs added by the source
rebase are present. Local full/sparse builds match 54 generated artifacts;
explicit test discovery is identical. Missing imported source, a named test or a
required descriptor still fails. Full Windows native/provisioning lanes remain
a separate qualification gate.

Test timings exclude dependency setup, checkout and queues. Checkout timings
include the action and shell/runner observation boundaries but exclude later
builds and provisioning. These scoped savings must not be summed or treated as
measured changes to full-shard occupancy or PR latency.

## October 5 mobile typecheck overlap

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/37249591578)
ran three alternating pairs on the four-core, 16 GB Linux ARM runner, with Node
24.21.0 and TypeScript 6.0.3. The production compiler and test-typecheck ratchet
use installed tools after dependency installation. Both resolved compiler
programs have `noEmit: true`, with no incremental, composite or build-info writes.
The change moves the existing unconditional production join after the foreground
ratchet and before tests; it changes no compiler command or failure policy.

| Complete typecheck stage | Original serial | Overlapped |
| ------------------------ | --------------- | ---------- |
| Pair 1                   | 68.284s         | 41.582s    |
| Pair 2, reversed order   | 65.385s         | 41.042s    |
| Pair 3                   | 64.240s         | 40.418s    |
| Median                   | 65.385s         | 41.042s    |

The median paired saving is 24.343 seconds, or 37.2% of this stage. The stage
bracket includes native background/wait boundaries and observation overhead,
but excludes dependency installation and the later test suite. All six stages
preserve the three workers' compiler/ratchet verdicts and stdout/stderr hashes.
The test compiler's existing diagnostics remain subject to the unchanged
ratchet. Neither compiler attempted native loading or recorded filesystem
mutations. Maximum aggregate owned-process RSS sampled every 200 milliseconds
was 5.137 GiB; this is a sampled value rather than a kernel peak. The ratchet now
runs even when the concurrently running production compiler later fails.

Two real, independent type faults still prevent tests from starting. The
production fault preserves the unaffected ratchet and child output; the test
fault preserves the production output and fails the ratchet. Their explicit
control receipts pass even though their intentionally failing jobs are allowed
to finish collecting evidence.

The separate [external cancellation control](https://github.com/stablyai/orca/actions/runs/37251289372)
held the two real installed compiler entrypoints before checking, while retaining
the production-background/ratchet-foreground topology. All three owned workers
were observed alive 14.275 seconds before the cancellation request. Both native
step outcomes became cancelled, tests did not start, and the runner's final
cleanup log names all three exact worker PIDs. The attempted earlier assertion
of PID absence failed: GitHub performs orphan cleanup after the always-tail
observer and artifact upload. Post-cleanup absence was not observed and is not
claimed. This control supplies no compiler-completion or timing measurement.

## October 5 explicit RPC registry test setup

The [hosted comparison](https://github.com/stablyai/orca/actions/runs/37251277897)
ran three alternating pairs of the complete 156-file mixed cohort on source
`d1e08ddd666e3099fc51c79f01f0305f5162186d`, using four workers on the four-core
Linux ARM runner, Node 24.21.0, pnpm 12.8.1 and Vitest 4.1.11. Persisted module
transforms and Node compile caches were disabled. All 153 candidate test files
pass explicit method lists to their dispatchers. A shared throwing fixture
prevents those tests from loading the unused default method catalog and rejects
any accidental iteration of it. The three real catalog subjects remain
unchanged and run beside the candidate subjects in every arm.

| Complete cohort process | Original | Candidate | Paired saving |
| ----------------------- | -------- | --------- | ------------- |
| Pair 1                  | 142.184s | 89.238s   | 52.946s       |
| Pair 2, reversed order  | 142.833s | 88.933s   | 53.900s       |
| Pair 3                  | 141.274s | 90.186s   | 51.088s       |
| Median                  | 142.184s | 89.238s   | 52.946s       |

The median paired saving is 37.2% of this fixed cohort. All six arms preserve
the complete ordered ledger, including duplicate parameterized case names:
1,469 passes and one existing setup-dependent skip, totaling 1,470 outcomes.
The real catalog subjects contribute 63 of those cases. Candidate bodies and
assertions are unchanged. One file at its line limit uses the dispatch method's
parameter type in place of its equivalent type-only import; its emitted code
matches the measured candidate.

Seventeen control invocations preserve actual terminal-handler fault detection,
reject unexpected default-catalog consumption, and still detect a missing real
catalog registration. A plain consumption counter prevents global mock-history
resets from erasing the guard; actual `clearAllMocks` and `resetAllMocks` controls
demonstrate that distinction and preserve unrelated call history. The isolated
driver restores all source files after success, faults and a real cancellation.
Independent review also confirms all 153 candidate sources, the fixture, three
catalog subjects and declared qualification inputs survive the rebase unchanged.

These are fresh-process wall times for this cohort, excluding dependency setup,
queues and other test shards. They do not measure full-shard balance, total PR
runner demand, or a change to the dashboard's PR runtime percentiles.
