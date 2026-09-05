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
  Compression savings need a hosted run; do not equate the full packaging step
  with removable compression time.
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
