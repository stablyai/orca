# Native dependency install policy

Ordinary `pnpm install` installs optional native dependencies for the current OS
and CPU only. This applies to local development and root-project CI jobs,
including jobs using `.github/actions/install-node-dependencies`. Mobile and
cloud projects with their own workspace configuration are separate.

The one cross-target build in the repo is macOS: `pnpm build:mac` and the four
macOS packaging workflows produce both x64 and arm64 artifacts from an arm64
runner. Before packaging for another architecture, widen the CPU set:

```sh
pnpm install:release
```

This runs `pnpm install --frozen-lockfile --cpu=current,x64,arm64`. It never
widens the OS set: every packaging job runs on a runner whose OS matches its
target, so cross-OS installs are never needed. The macOS workflows pass
`--cpu=current,x64,arm64` directly; Windows and Linux packaging jobs use a plain
host-only `pnpm install --frozen-lockfile`. Keeping `current` in the list
preserves the host's build tools alongside the target resources. An install for
another target does not itself cross-compile native addons.

## Packaging guard

electron-builder only logs a warning for a missing `extraResources` source and
continues, so without a check a foreign-architecture slice would ship silently
broken. `beforePack` in
[`config/electron-builder.config.cjs`](../../config/electron-builder.config.cjs)
therefore calls `assertPackagedNativeVariantsInstalled` in
[`config/packaged-runtime-node-modules.cjs`](../../config/packaged-runtime-node-modules.cjs),
which fails the build when the target platform/architecture's native variants
are not installed: `sherpa-onnx-*`, `@parcel/watcher-*`, and on Windows the
node-gyp addon `@vscode/windows-process-tree`. The error names every missing
package and gives the remedy that fits: another architecture's variants come
from `pnpm install:release`, the Windows addon does not (see below).

Windows packaging requires a Windows host. `@vscode/windows-process-tree` is an
`os: win32` npm addon, so it is installed only where that matches;
`@orca/windows-registry` is a workspace package that links on every host, but
its native binary is still compiled only on Windows. Both are compiled only by
the Windows-only rebuild in `config/scripts/rebuild-native-deps.mjs`
(`allowBuilds` in `pnpm-workspace.yaml` keeps pnpm itself from running node-gyp
for them). The guard checks `@vscode/windows-process-tree` alone because the
workspace link is present everywhere and proves nothing. `pnpm install:release`
does not help on macOS or Linux because it does not widen the OS set.

Tests that inspect installed Windows addons and their packaging closure run on
Windows, where those dependencies are required. The PR Windows lane explicitly
includes them. Loading the packaging config tolerates absent Windows addons; only
`beforePack` rejects Windows packaging until they are installed. Patch-source
assertions, fixture tests, and the isolated real patch-install test continue to
run on other hosts.

## Existing checkouts

A narrowing incremental install can leave previously installed variants behind.
Stop development processes using this checkout, remove **this checkout's**
`node_modules`, then run `pnpm install --frozen-lockfile` to obtain a fresh host
install. Do not use `--force`: pnpm 12 documents that it installs optional
packages even when their OS/CPU/libc do not match. The shared pnpm download store
is separate; this change does not clear it.

## Measurement: macOS arm64, pnpm 12.0.0

Measured 2026-09-12 with the same package manifest, lockfile, patch files, and
existing download store in two fresh install directories, both with
`--frozen-lockfile --ignore-scripts --offline`. One used the earlier broad
policy (`--os=current,darwin,linux,win32 --cpu=current,x64,arm64`); the other
used `--os=current --cpu=current`. Numbers are logical file bytes in the virtual
store, **not unique disk usage**: pnpm hardlinks and APFS clones may share
storage.

| Measure                                    | Broad install |  Host install |             Reduction |
| ------------------------------------------ | ------------: | ------------: | --------------------: |
| Package directories                        |         1,296 |         1,206 |                    90 |
| Regular files                              |        53,972 |        52,915 |                 1,057 |
| Logical package bytes                      | 2,485,153,773 | 1,159,396,649 | 1,325,757,124 (53.3%) |
| Logical package GiB                        |          2.31 |          1.08 |                  1.23 |
| Install wall time, single warm-cache trial |       11.98 s |       11.25 s |                0.73 s |

| Native family       | Broad MiB | Host MiB |
| ------------------- | --------: | -------: |
| Canvas              |     235.7 |     25.8 |
| Sherpa speech       |     235.2 |     71.6 |
| oxlint and tsgolint |     234.0 |     32.7 |
| SWC                 |     225.8 |     24.4 |
| TypeScript          |     158.4 |     26.2 |

Electron downloads and native rebuild outputs are absent from both trials. The
single warm-cache timing pair does not establish a speedup, and Linux/Windows
results were not measured; do not present the macOS numbers as CI savings.
