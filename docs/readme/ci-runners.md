# CI runners

Default to free GitHub-hosted standard runners: the repository is public and the
Enterprise plan allows 1,000 concurrent jobs (50 macOS). Use Blacksmith only for:

- `pr.yml` Git compatibility: its parallel real-Git lanes, two through Docker,
  exceed test timeouts on 4-vCPU hosted runners.
- macOS packaging: adhoc, hourly, daily and `release-mac-build.yml`. Hosted
  `macos-15` cannot boot the packaged x64 terminal host that `afterPack` verifies.
- The adhoc Windows build (a developer is waiting).
- Hardware-sensitive performance benchmarks. Operation-count contracts
  (`performance-contracts.yml`) are not, and run hosted.

PR checks run entirely on hosted runners except Git compatibility. Unit tests
run as 12 shards on `ubuntu-24.04-arm`, which match the old five 8-vCPU
Blacksmith shards; `ORCA_UNIT_FULL_SHARD_COUNT` tunes the count. Preflight (lint
and typecheck) also runs on hosted ARM: shards, packaging and the layout oracle
do not wait for it, so its slower runner stays off the gate's critical path.
The layout oracle and advisory e2e lanes run on `ubuntu-24.04`.

Everything else, including the hourly and daily Windows builds, template
qualification and node-server lanes, runs on hosted `ubuntu-*`, `macos-15` and
`windows-2022` images. Do not use paid GitHub
larger runners: they cost more than Blacksmith at every size and Enterprise
included minutes do not cover them.

On Blacksmith, small routing and reporting jobs use 2 vCPUs; most test jobs use
4; compilation and shared JavaScript builds use 8. Mac checks use the 6-vCPU
Apple Silicon runners, including adhoc and release Mac packaging.

Keep matrix platform keys separate from runner labels: platform keys select
native slots, architectures, cache identities, and upload conditions.

## Cache stores

Blacksmith redirects `actions/cache` to its own store ("Enabling Blacksmith
transparent cache"); GitHub-hosted jobs use the repository's Actions cache. The
stores do not share entries, so the warmers (`ci-cache-warmup*.yml`) seed each
identity in both pools. Native module keys include the OS image, so a hosted
`ubuntu-22.04` consumer needs a hosted `ubuntu-22.04` warm leg.

GitHub's Actions cache is capped at 10 GB per repository and evicts the least
recently used entries first. Seed shared caches from `main`; avoid per-PR saves
of large or single-use artifacts, and prefer the lookup-only and restore-only
patterns in `.github/actions`.

## Production signing

SignPath requires every job in the signing workflow to use GitHub-hosted runners,
including jobs inside reusable workflows. `release-cut.yml` therefore explicitly
passes `fast_runners: false` to template qualification and `runner: ubuntu-latest`
to dependency security and shared JavaScript compilation. Preserve these overrides
when changing shared defaults.

The production Mac build already runs on Blacksmith in the separately dispatched
`release-mac-build.yml`. Keep its exact-run identity checks and publication gates.
Moving more production work to Blacksmith requires another isolated workflow;
changing a runner label inside `release-cut.yml` breaks signing provenance.

## Platform exceptions

These stay on GitHub-hosted runners even where the policy above picks Blacksmith:

- Windows WSL and WSL2 tests retain GitHub runners: Blacksmith Windows runners do
  not support the required nested virtualization.
- Windows signing and its rehearsal retain GitHub runners for SignPath provenance.
- Intel Mac and Windows ARM qualification retain their native GitHub runners;
  Blacksmith does not offer these architectures.
- Windows desktop lifecycle tests retain their existing GitHub desktop images.
- Mac SSH hostile-host tests retain GitHub images because Blacksmith's shell
  initialization restores the toolchain PATH that these fixtures must hide.
- Linux libc qualification keeps its pinned manylinux and Alpine containers,
  regardless of the host runner pool.

The shared dependency installer preserves temporary login-shell homes on
Blacksmith Linux hosts. Container jobs skip this host-image adjustment.

Runner availability: <https://docs.blacksmith.sh/blacksmith-runners/overview>.
Signing requirements: <https://docs.signpath.io/trusted-build-systems/github>.
