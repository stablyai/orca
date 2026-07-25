# Relay Node-Pty Toolchain

## Problem

The pet's `omp` assistant runs in a pane on the worktree's owner
host. When the worktree is hosted on a remote machine, that owner
host is reached through the Orca relay — and the relay depends on
two native addons (`node-pty`, `@parcel/watcher`) being installed on
the remote host against its Node.js version and OS. The Linux side
of that install has been the dominant first-connect failure for
years (#1693), and three orthogonal pieces make it fragile:

- **No Linux prebuild.** `node-pty@1.1.0` ships no Linux prebuild, so
  the remote `npm install` falls back to `node-gyp rebuild` and
  needs a C/C++ toolchain. A missing toolchain surfaces as an opaque
  `not found: make` from `node-gyp`, not as "install
  `build-essential`".
- **glibc / `MODULE_VERSION` mismatch.** When the remote is on a
  glibc old enough that Node's `MODULE_VERSION` does not match the
  prebuild's symbol versions, `require('node-pty')` succeeds at
  install time and fails at runtime. The probe-then-require flow
  catches it (`node-pty error hints`), but the failure is non-fatal
  by design: relay still serves `fs`/`git`/`preflight`, only
  `pty.spawn` fails at runtime.
- **Per-relay-dir rebuild.** The relay is installed at
  `~/.orca-remote/relay-<full-version>/`, one directory per Orca
  build, so the rebuild has to happen per-relay-dir — not globally.
  Build-time prune keeps the host-arch prebuild in the packaged tree
  and drops the rest, but a fresh `npm install` on the remote still
  needs the toolchain to compile Linux from source.

The fork's pet arc adds another constraint on top: every worktree
hosted on an SSH/WSL target gets a relay, so the toolchain failure
becomes a pet-arc failure, not just a relay-arc failure.

## Goal

- Surface a missing toolchain as an actionable message tied to the
  remote's package manager, not as `node-gyp`'s `not found: make`.
- Keep the probe best-effort so Windows hosts (which ship win32
  prebuilds and do not need a toolchain) and probe-erroring hosts
  fall back to the original install error rather than a worse one.
- Make the rebuild per-relay-dir — never assume a global toolchain
  install on the remote is sufficient or even possible (some hosts
  refuse root).
- Match Node's `MODULE_VERSION` against the prebuild's glibc
  requirement so a built-but-unloadable addon is detected and
  rebuilt, not silently passed through.

## Non-goals

- Replacing the `node-pty` / `@parcel/watcher` pair with a different
  addon. They are the only way the relay exposes `pty.spawn` today
  and have the right Electron-side surface for the desktop to use
  them directly.
- Installing the toolchain automatically. The hint names the package
  manager command; the operator still runs it.
- Tracking per-distro package names beyond what the probe already
  enumerates. The list (`apt-get`, `dnf`, `yum`, `pacman`, `apk`,
  `zypper`) covers every supported Linux family.
- Replacing the build-time prebuild prune. The packaged tree only
  carries the host-arch prebuild so a packaged-external verifier
  passes on the dev tree; that is independent of the remote toolchain
  story.

## Implementation

The relay node-pty toolchain story lives in three files in
`src/main/ssh/`:

### Toolchain probe — `src/main/ssh/ssh-relay-build-toolchain.ts`

A POSIX-sh probe emits one `HAVE <tool>` line per resolvable build
tool and a single `PKG <manager>` line for the host's package
manager. Runs under `/bin/sh -c` (see `wrapRemoteCommandForPosixShell`),
so it stays portable across distros.

`PROBED_TOOLS` (line 10): `make`, `gcc`, `g++`, `cc`, `c++`, `clang`,
`clang++`, `python3`, `python`. `node-gyp` needs `make`, Python, and
a C++ compiler.

`PACKAGE_MANAGER_HINTS` (line 24): one-liners per distro family,
ordered by detection priority:

```
apt-get   → sudo apt-get install -y build-essential python3
dnf       → sudo dnf install -y make gcc gcc-c++ python3
yum       → sudo yum install -y make gcc gcc-c++ python3
pacman    → sudo pacman -S --needed base-devel python
apk       → sudo apk add build-base python3
zypper    → sudo zypper install -y gcc gcc-c++ make python3
```

`parseBuildToolchainProbe(output)` collapses the `HAVE` lines into a
`BuildToolchainStatus`; `formatMissingToolchainError(status,
underlyingError)` rewrites the opaque `not found: make` into the
distro-specific hint. NixOS does not have `apt-get` / `dnf` /
`pacman` / `apk` / `zypper` in the standard install; on NixOS the
probe reports `present: []` and the hint names the missing tools so
the operator can build a `shell.nix` with `gcc`, `gnumake`, and
`python3` in `buildInputs` — that is the path the fork has settled
on for NixOS relay nodes (it is the only path that survives a
`nixos-rebuild switch`).

`probeBuildToolchain(conn, hostPlatform, signal)` returns the
status, or `null` on Windows hosts (node-pty ships win32 prebuilds)
or if the probe itself errors. Callers fall back to the original
install error in those cases.

`shouldProbeBuildToolchainAfterNativeDepsFailure(message)` matches
the `node-gyp` failure shapes so the probe only runs when the
underlying error actually points at a native-build failure.

### Deploy / install — `src/main/ssh/ssh-relay-deploy.ts`

`RELAY_NATIVE_DEPS` (line 550) is the locked list of native addons
the relay needs. `RELAY_NATIVE_DEP_SCRIPT_ALLOWLIST` is the npm 12
lifecycle-script allowlist (npm 12 blocks lifecycle scripts unless
each exact package version is approved, even with
`ignore-scripts` disabled). `NATIVE_DEPS_MISSING_PREFIX` is the
sentinel the probe emits when an addon is missing; `installNativeDeps`
runs the probe, parses the result, and on missing deps either
abandons or repairs the install (see `probeRequiredNativeDeps`,
`repairInstalledNativeDeps`, `resetNativeDepsCommand`,
`rebuildNativeDeps`).

`installNativeDeps` (line 743) is the single install path; the
comment above it captures the long-term direction:

> TODO(#1693): VS Code ships per-platform tarballs with node-pty
> pre-built from CI and skips `npm install` on the remote entirely.
> That approach eliminates the whole class of bugs around npm /
> compiler / network failures on the remote. Worth doing once we're
> past the immediate fix.

`rebuildNativeDeps` (line 904) runs the per-relay-dir rebuild. The
comment is the non-obvious bit: `node-pty` and `@parcel/watcher` are
native addons that cannot be bundled by esbuild. They must be
installed on the remote host against its Node.js version and OS so
dynamic imports / `require` calls resolve from the relay dir.

`makeNodePtySpawnHelperExecutable` (line 931) finds every
`spawn-helper` prebuild under the relay dir and `chmod +x` it. SFTP
does not preserve execute bits; without this, `pty.spawn` would
fail on Linux even after a successful install.

`probeInstalledNativeDeps` (line 950) tries `require()`-equivalent
loads so a built-but-unloadable addon (e.g. wrong glibc) is
detected at install time, not at first relay launch. The probe
failure is non-fatal by design (the test at
`src/main/ssh/ssh-relay-native-deps-install.test.ts:402` pins this):

> Probe failure is non-fatal by design (see
> docs/ssh-relay-versioned-install-dirs.md): relay still serves
> fs/git/preflight, only pty.spawn fails at runtime. Throwing here
> would loop reconnects forever on hosts where node-pty truly
> cannot build (Alpine without compiler, glibc too old).

That same test (`'rebuilds unloadable native deps and recovers
before first relay launch'`) pins the repair path: a probe failure
followed by `repairProbe: 'ok'` must end in a `finalizeInstall`
call and no `abandonInstall`.

### Deploy helpers — `src/main/ssh/ssh-relay-deploy-helpers.ts`

`execCommand` is the single SSH exec wrapper used by the deploy and
the toolchain probe. The contract for "the merged message keeps the
node-gyp failure visible" is pinned in
`src/main/ssh/ssh-relay-deploy-helpers.test.ts` so a hint that
swallows the underlying error fails CI.

## Per-relay-dir rebuild

The relay is installed at `~/.orca-remote/relay-<full-version>/`,
versioned by Orca's full version (`readLocalFullVersion` →
`computeRemoteRelayDir`). Each version gets its own
`node_modules/`, so a rebuild has to be re-run per relay dir; a
global `pnpm rebuild node-pty` on the remote does not reach the
relay's pinned `node_modules/`. `installNativeDeps` and
`rebuildNativeDeps` are scoped to the relay dir they were called
with, and `acquireRelayLaunchGcFence` plus the install lock keep
two concurrent relay launches from racing the rebuild.

## Verification

- `src/main/ssh/ssh-relay-build-toolchain.test.ts` — probe parsing,
  hint formatting, NixOS-style empty-`present`-set paths.
- `src/main/ssh/ssh-relay-deploy-helpers.test.ts` — exec wrapper,
  merged error contract.
- `src/main/ssh/ssh-relay-native-deps-install.test.ts` —
  install-probe contract (the regression coverage for the original
  "node-pty is not available" bug, see file header comment), plus
  the repair-then-finalize invariant.
- `src/main/ssh/ssh-relay-deploy.test.ts` — full deploy path
  including the toolchain-probe branch.
- `src/main/daemon/node-pty-error-hints.test.ts` — pty-diagnostic
  parsing on the local side; matches `posix_openpt` / `grantpt` /
  `unlockpt` / `ioctl_TIOCPTYGNAME` / `open_slave` failures and the
  exhaustion ernos.

## References

- `docs/reference/reliability-pain-points-2026-06-30.md` —
  "stale node-pty helper path" is one of the tracked pains; the
  toolchain probe and per-relay-dir rebuild are part of the same
  narrative.
- `package.json` — `"rebuild:node": "pnpm rebuild node-pty"` is the
  local-side equivalent. The remote-side rebuild is in
  `rebuildNativeDeps` and runs against the relay dir, not the
  install root.
- `config/patches/node-pty@1.1.0.patch` — the local-side patch
  Orca applies before packaging; not part of the toolchain story
  but worth knowing if you are debugging a built-but-unloadable
  addon locally.