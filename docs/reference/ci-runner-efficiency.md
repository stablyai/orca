# CI efficiency and runner capacity

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
