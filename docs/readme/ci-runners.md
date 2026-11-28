# CI runners

Default to free GitHub-hosted standard runners: the repository is public and the
Enterprise plan allows 1,000 concurrent jobs (50 macOS). Use Blacksmith only for:

- macOS packaging: adhoc, hourly, daily and `release-mac-build.yml`. Hosted
  `macos-15` cannot boot the packaged x64 terminal host that `afterPack` verifies.

PR checks, Linux and Windows builds (including adhoc, hourly, and daily Windows),
template qualification, node-server lanes, and benchmarks run entirely on
GitHub-hosted `ubuntu-*`, `macos-15`, and `windows-2022` runners. Unit tests
run as 12 shards on `ubuntu-24.04-arm`, which match the old five 8-vCPU
Blacksmith shards; `ORCA_UNIT_FULL_SHARD_COUNT` tunes the count. Preflight (lint
and typecheck) also runs on hosted ARM: shards, packaging and the layout oracle
do not wait for it, so its slower runner stays off the gate's critical path.
The layout oracle and advisory e2e lanes run on `ubuntu-24.04`. Git
compatibility runs one Git version per hosted job: three lanes sharing one
4-vCPU runner pushed real-Git tests past their timeouts.

Keep matrix platform keys separate from runner labels: platform keys select
native slots, architectures, cache identities, and upload conditions.

## Cache stores

All Linux and Windows jobs share GitHub's Actions cache store (macOS packaging
jobs on Blacksmith use Blacksmith's transparent cache). Native module keys
include the OS image, so a hosted `ubuntu-22.04` consumer needs a hosted
`ubuntu-22.04` warm leg.

GitHub's Actions cache is capped at 10 GB per repository and evicts the least
recently used entries first. Seed shared caches from `main`; avoid per-PR saves
of large or single-use artifacts, and prefer the lookup-only and restore-only
patterns in `.github/actions`.

## Production signing

SignPath requires every job in the signing workflow to use GitHub-hosted runners,
including jobs inside reusable workflows. `release-cut.yml` runs template
qualification, dependency security, and shared JavaScript compilation on
GitHub-hosted runners.

The production Mac build runs on Blacksmith in the separately dispatched
`release-mac-build.yml`. Keep its exact-run identity checks and publication gates.
Moving more production work to Blacksmith requires another isolated workflow;
changing a runner label inside `release-cut.yml` breaks signing provenance.

## Platform exceptions

- Windows signing and its rehearsal stay on GitHub-hosted runners for SignPath provenance.
- Linux libc qualification keeps its pinned manylinux and Alpine containers.

Runner availability: <https://docs.blacksmith.sh/blacksmith-runners/overview>.
Signing requirements: <https://docs.signpath.io/trusted-build-systems/github>.
