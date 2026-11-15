# Boot-twice check

This check catches the case where the image boots but a wake reinstalls or refetches things.

It provisions the golden image in a container, using the real `provision-golden.sh` and the same
env that `build-golden-image.ts` passes. Then it boots the same disk twice through the control
plane's own boot code:

1. `ENTRY_POINTS_PROBE` plus the install when the image's scripts are behind (the `refreshRuntime` step).
2. `startOrcad`, with the workspace prelude on the first boot only.
3. `ensureEntryPoints`, the once-per-image entry-point sync.

Each container start counts as one VM boot. The container gets a fresh kernel boot id, a tmpfs
`/run`, and the disk the previous boot left (`docker commit`).

The second boot must:

- **Come up.** It needs a pairing offer, and orcad must be alive and listening on `:6768`.
- **Install nothing.** `docker diff` against the first boot's disk may only touch boot state:
  `~/.orca-sandbox`, `~/.orcad-data`, the per-boot agent config, the compile cache, `/tmp` and
  `/run`. See `bootStatePaths` in `boot-twice-checks.ts`. Any `node_modules`, or any change under
  `/opt/orca/bin`, `/usr`, `/etc` or a package cache, fails the check.
- **Fetch nothing.** The boot runs on an internal Docker network (no route out). Its only DNS
  server is a sink that logs every name it is asked for. A lookup fails the check unless it is in
  `RUNTIME_LOOKUPS`. Today that is only orcad's agent-state-rules refresh on github.com.
- **Redo nothing.** The container's init samples every process's command line every 50 ms. Any
  installer, fetch or first-run command (apt, npm install, curl, git fetch, `opencode models`)
  fails the check.
- **Skip the entry-point install.** No `installEntryPoints` call, and the first boot's
  `.entry-points-<hash>` marker is present.
- **Carry the right files.** Every `/opt/orca/bin` entry point must be byte-identical to `image/vm/`,
  `.scripts-stamp` must equal `VM_SCRIPTS_STAMP`, and every manifest pin must match the installed
  version. The npm packages are compared exactly, by their `package.json`. gh, cursor-agent and
  Chrome are compared by `--version`.

## Run it locally

You need Docker that can run `--privileged` containers: Linux, or Docker Desktop on macOS.

```sh
cd cloud
pnpm install --filter @orca-cloud/sandbox-control...
pnpm --filter @orca-cloud/sandbox-control exec tsx image/boot-twice/boot-twice.ts --release latest
```

A cold run takes about 4 minutes, almost all of it provisioning (apt, agent CLIs, Chrome).
Docker's layer cache keys on the provisioning inputs: `provision-golden.sh`, the manifest and the
entry points. A rerun with those unchanged takes about 15 seconds. The command exits non-zero and
lists each failure.

The options:

- `--report <file>` writes the full JSON report: boot timings, every command, the disk diff, lookups and versions.
- `--keep` leaves the two containers, the disk image and the DNS sink for inspection.
- `--release vX.Y.Z` boots a specific orca-server release bundle. The default is the latest
  release, because the manifest pins no bundle: production goldens build orcad from source.
- `--image <tag>` boots an image you built yourself. `--context-out <dir>` writes the build context for one.

What this check does not cover:

- The runtime-bundle refresh: no bundle is published here.
- The Vercel firewall and egress proxy: that is the release probe, `scripts/egress-probe.ts`.
- Vercel's own VM behaviour, such as snapshot restore timing.

## CI

On nwparker/orca-private, where Actions is off, the premerge gate
(`config/scripts/cloud-integration/premerge-check.sh`) runs
`config/scripts/cloud-integration/boot-twice-check.sh` whenever a branch touches
`cloud/apps/sandbox-control/image/**`, which includes every VM script. The step:

- takes its own omarchy slot, waiting at most 5 minutes for one;
- stops after 10 minutes;
- prints each failure;
- **fails open with a loud warning when Docker is unavailable**.

`.github/workflows/cloud-vm-boot-twice.yml` runs the same check on pull requests once Actions is
on, with the provisioned layer cached in the GitHub Actions cache.
