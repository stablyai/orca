# Linux glibc Compatibility

Orca's Linux builds target **stock Ubuntu 20.04 and newer** — glibc 2.31 and
libstdc++ `GLIBCXX_3.4.28` (also Debian 11, RHEL 9), on both x64 and arm64.
Packaging enforces this floor automatically; keep it in mind when adding or
upgrading native dependencies. (The optional speech feature is the one
exception — see below.)

## Local package build prerequisites

`pnpm run build:linux` produces AppImage, deb, and RPM artifacts. The RPM target
requires `rpmbuild` on `PATH`; install `rpm` on Ubuntu/Debian, `rpm-build` on
Fedora/RHEL, or `rpm` through Homebrew on macOS, then verify it with
`rpmbuild --version` before packaging. Cross-host builds have the same
requirement.

## Why this needs attention

A native module (`.node`) links against the glibc of the machine that compiled
it. Build runners' glibc rises over time as their images are bumped. A binary compiled on
a newer glibc can reference symbol versions that do not exist on an older target,
and the dynamic loader then refuses to load it:

```
/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by .../pty.node)
```

Older Orca releases loaded node-pty in the main process at startup, so that failure
crashed the whole app before a window appeared. This shipped in v1.4.150 and
broke launch on Ubuntu 20.04 ([#9902](https://github.com/stablyai/orca/issues/9902)).

The specific trap is glibc's 2.32–2.34 "libpthread/libutil merge", which moved
several long-stable functions into libc under brand-new symbol versions:

| Symbol            | New version  | node-pty use            |
| ----------------- | ------------ | ----------------------- |
| `pthread_sigmask` | `GLIBC_2.32` | reset child signal mask |
| `openpty`         | `GLIBC_2.34` | allocate the pty        |
| `forkpty`         | `GLIBC_2.34` | fork the shell          |

Electron itself (glibc 2.25) and the other bundled native modules
(`sherpa-onnx`, `@parcel/watcher`, both prebuilt on old glibc) stay well under
the floor, so node-pty was the sole blocker.

## How we keep the floor

**1. Use the qualified bundled terminal runtime.** Desktop and headless terminal
services use pinned Bun. The former node-pty symbol-version patch is retired;
the historical failure above still explains why every native artifact needs a
floor check. Native dependencies compiled from source must use a compatible
sysroot or explicitly preserve the older symbol versions and required libraries.

**2. Gate packaging (the regression guard).**
[`config/scripts/verify-linux-glibc-floor.cjs`](../../config/scripts/verify-linux-glibc-floor.cjs)
runs in the electron-builder `afterPack` hook for Linux. It reads every bundled
native binary's version needs (`objdump -p` "Version References" — the
authoritative load-time list, which also captures symbol-less markers like
`GLIBC_ABI_DT_RELR`) and fails the build if any strong `GLIBC_`/`GLIBCXX_`/
`CXXABI_` node is newer than stock Ubuntu 20.04 provides, naming the file and the
offending node. Weak needs are ignored (the loader tolerates them). It also
asserts the flip side of the `.symver` fix: any binary that imports
`openpty`/`forkpty` must keep `libutil.so.1` in `DT_NEEDED` — otherwise the
pinned `openpty@GLIBC_2.2.5` resolves from libc's compat alias at build time (so
the version check passes) yet fails to load on 20.04, where those functions live
only in libutil. A future runner bump, a new native dependency, or a dropped
ldflag therefore fails the release build instead of shipping a Linux app that
crashes on launch.

The static gate is paired with
`config/scripts/run-linux-packaged-terminal-floor-smoke.mjs`, which launches the
packaged Bun daemon through the packaged Electron client in Ubuntu 20.04. It
checks real shell output, resize, history/snapshots, reconnect and exit handling
on the release architectures.

The one carve-out is the `sherpa-onnx` speech prebuilt, which already requires
`GLIBCXX_3.4.29` (GCC 11). It loads lazily in the speech worker
(`src/main/speech/stt-worker.ts`), never at app launch, so it is exempt from the
libstdc++ floor — its glibc needs are still checked. Speech-to-text therefore
needs a host with libstdc++ from GCC 11+ (Ubuntu 21.10 / 22.04 LTS or newer); the
app itself still launches on stock 20.04.

**3. Qualify the bundled headless runtime and its native dependencies.**
Orcad and the SSH relay use pinned Bun for terminals. They do not install node-pty
prebuilds or compile node-pty on the remote host. Desktop Electron uses the same
terminal service runtime; the build gates above cover its packaged artifacts.

The Bun runtime catalog selects glibc or musl artifacts for each supported CPU.
The bundled-runtime CI checks the Linux glibc floor and runs native dependency
and terminal tests. Orcad validates artifact identity and SQLite readiness before
opening profile state; its disposable native-feature probe also checks PTY and
watcher operation. An inconclusive optional feature probe must not be treated as
proof that a host cannot start.

## Adding or upgrading a native dependency

- Prefer packages that ship prebuilt binaries compiled against an old toolchain
  (manylinux / `glibc 2.17`-class), like `@parcel/watcher`.
- For a module we compile from source, if the gate flags it, either pin the
  offending symbols to compatible versions, or build it in an old-glibc container.
- To check locally on a Linux host, list what a binary requires (skipping the
  weak `0x02`-flagged needs the loader tolerates):

  ```bash
  objdump -p path/to/module.node | sed -n '/Version References/,/^$/p'
  ```

  No strong `GLIBC_` node may exceed `2.31`, and no `GLIBCXX_`/`CXXABI_` node may
  exceed `3.4.28`/`1.3.12` — what stock Ubuntu 20.04 ships.

## Runtime floor: the `environ` race below glibc 2.41 (Electron ≥ 43.7.0)

Separate from the build floor above, one glibc runtime bug constrains which
Electron we may ship. Before glibc 2.41, `setenv`/`unsetenv` reallocate the
`environ` array and **free** the old one, so a concurrent `getenv()` on another
thread reads freed memory. Ubuntu 20.04–24.04 (2.31–2.39) are all below that
line, so every Linux target we support is exposed.

Electron 43.5.0 made that latent race reachable on every launch: it started
setting `GDK_GL=disable` around `gtk_init()` and unsetting it right after, while
in the same change moving FontConfig warm-up onto a thread-pool thread that runs
concurrently and calls `getenv()` constantly
([electron#53070](https://github.com/electron/electron/pull/53070)). The result
is a browser-process use-after-free about a second into startup — no window, no
GPU child involved, and the corruption surfaces wherever the next allocation
lands, which is why reports name unrelated frames (`gtk_widget_realize`,
libxcb-dri3, FontConfig/expat). Orca 1.4.199/1.4.200 shipped that runtime and
died on launch on Ubuntu + NVIDIA/X11
([#20081](https://github.com/stablyai/orca/issues/20081)).

Electron 43.7.0 fixes it by overriding `setenv`/`unsetenv`/`putenv`/`clearenv`
so a published `environ` is never freed, deferring to glibc on 2.41+
([electron#53491](https://github.com/electron/electron/pull/53491), backported
to 42/43/44/45). **Do not downgrade Electron below 43.7.0, or move to another
line, without confirming that backport is in the target release** —
`config/scripts/electron-runtime-floor.test.ts` fails the suite if the pin drops
below the floor. Orca itself writes `process.env` during early startup
(`patchPackagedProcessPath`, `configureOrcaUserDataPathEnv`,
`hydrate-shell-path`), so it is a first-class trigger, not just a bystander.
