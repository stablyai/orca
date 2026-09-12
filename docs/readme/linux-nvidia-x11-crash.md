# Linux NVIDIA/X11 startup and typing crash

[Issue #20081](https://github.com/stablyai/orca/issues/20081) reports that Orca
1.4.198 works with Electron 43.4.1, while 1.4.199/1.4.200 crash with Electron
43.6.0 on Ubuntu, X11, and NVIDIA driver 580.178.04.

The reporter confirmed that a local `1.4.200-nvidia.1` amd64 package using
Electron 43.4.1 opened and accepted typing in the composer and terminal.

Electron 43.4.1 is affected by
[GHSA-qmv3-fv6v-rmhq](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq).
Keep the shared manifest, lockfile, and normal release builds on the current
patched Electron version. The older runtime is only a temporary diagnostic
comparison, not a release fix or a recommendation for daily use.

## Opt-in Linux diagnostic package

On Linux x64, use Bash, Node 24, pnpm 12, Git, and the normal Linux packaging
prerequisites. Run the following from the repository root. It snapshots the
committed source into a separate directory; it does not include uncommitted
changes. Only that snapshot receives the Electron downgrade. Do not commit its
manifest or lockfile back to the release branch.

```bash
set -euo pipefail
diagnostic_dir=$(mktemp -d "${TMPDIR:-/tmp}/orca-nvidia-20081.XXXXXX")
git archive HEAD | tar -x -C "$diagnostic_dir"
(
  cd "$diagnostic_dir"
  export ORCA_BACKGROUND_LAUNCH=1
  pnpm install --frozen-lockfile
  pnpm add --save-dev --save-exact electron@43.4.1
  pnpm run build:desktop
  pnpm run ensure:electron-runtime
  ORCA_LOCAL_BUILD_VERSION=1.4.200-nvidia.1 pnpm exec electron-builder \
    --config config/electron-builder.config.cjs --linux deb --x64 --publish never
)
printf 'Diagnostic package: %s/dist/orca-ide_1.4.200-nvidia.1_amd64.deb\n' "$diagnostic_dir"
```

The explicit `--publish never` keeps this package local. The normal native
rebuild, glibc compatibility, packaged daemon, and CLI checks still run against
the snapshot's installed dependencies. Keep this workflow out of release CI.

## Validate the comparison

Quit the installed Orca process before installing and launching the diagnostic
package from the desktop. Test typing in both the composer and terminal, then
quit, relaunch, and repeat. Record the package version, Electron version, GPU
driver, and display session type with the result in #20081.

The report says `--in-process-gpu --disable-gpu-sandbox` still crashes on the
first keystroke; do not add those flags or override the user's IBus settings as
a fix for this issue.

A successful diagnostic run would narrow the regression, not resolve the
security issue. A permanent fix still needs a security-patched Electron build
that passes the same checks on the affected NVIDIA/X11 machine. A successful
build or unit test alone does not establish that this native-driver crash is fixed.
