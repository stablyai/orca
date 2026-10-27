# CI runners

Use Blacksmith for ordinary PR checks, Linux E2E, cache preparation, mobile checks,
and unsigned desktop builds. Small routing and reporting jobs use 2 vCPUs; most
test jobs use 4; compilation and shared JavaScript builds use 8. Mac checks use
the 6-vCPU Apple Silicon runners. Adhoc Mac packaging uses 12 vCPUs.

Keep matrix platform keys separate from runner labels: platform keys select
native slots, architectures, cache identities, and upload conditions.

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
