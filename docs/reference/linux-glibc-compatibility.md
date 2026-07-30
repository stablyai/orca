# Linux glibc Compatibility

Orca's Linux builds target **stock Ubuntu 20.04 and newer** — glibc 2.31 and
libstdc++ `GLIBCXX_3.4.28` (also Debian 11, RHEL 9), on both x64 and arm64.
Packaging enforces this floor automatically; keep it in mind when adding or
upgrading native dependencies. (The optional speech feature is the one
exception — see below.)

## Why this needs attention

A native module (`.node`) links against the glibc of the machine that compiled
it. Our release CI compiles node-pty from source on GitHub's `ubuntu-latest`
runner, whose glibc rises over time as the image is bumped. A binary compiled on
a newer glibc can reference symbol versions that do not exist on an older target,
and the dynamic loader then refuses to load it:

```
/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by .../pty.node)
```

Because the Orca main process loads node-pty at startup, that failure crashes the
whole app before a window appears — this is exactly what shipped in v1.4.150 and
broke launch on Ubuntu 20.04 ([#9902](https://github.com/stablyai/orca/issues/9902)).

The specific trap is glibc's 2.32–2.34 "libpthread/libutil merge", which moved
several long-stable functions into libc under brand-new symbol versions:

| Symbol            | New version   | node-pty use            |
| ----------------- | ------------- | ----------------------- |
| `pthread_sigmask` | `GLIBC_2.32`  | reset child signal mask |
| `openpty`         | `GLIBC_2.34`  | allocate the pty        |
| `forkpty`         | `GLIBC_2.34`  | fork the shell          |

Electron itself (glibc 2.25) and the other bundled native modules
(`sherpa-onnx`, `@parcel/watcher`, both prebuilt on old glibc) stay well under
the floor, so node-pty was the sole blocker.

## How we keep the floor

**1. Pin the relocated symbols (the fix).**
[`config/patches/node-pty@1.1.0.patch`](../../config/patches/node-pty@1.1.0.patch)
adds a `.symver` shim in `src/unix/pty.cc` that binds `openpty`, `forkpty`, and
`pthread_sigmask` to their pre-merge version node — `GLIBC_2.2.5` on x64,
`GLIBC_2.17` on arm64 (each architecture's baseline glibc). glibc still ships
those as compatibility aliases, so the reference resolves on both new build hosts
and old targets.

The catch: gcc defaults to `--as-needed` and, since the pinned symbols now
resolve from libc's compat aliases at build time, it drops `libutil`/`libpthread`
from `DT_NEEDED`. On the target those libraries are where the symbols actually
live, so the patch's `binding.gyp` `ldflags` force
`-Wl,--no-as-needed,-l:libutil.so.1,-l:libpthread.so.0` back into `DT_NEEDED`.
The shim is guarded by `#if defined(__linux__)`; macOS and Windows are untouched.

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

> The gate is a static invariant, not an integration test. The load path was
> verified by hand for this fix (real Ubuntu 20.04, x64 + arm64: `require`
> node-pty and spawn a shell). A CI smoke test that loads the packaged
> `pty.node` in a glibc-2.31 container and spawns a shell is the recommended
> follow-up — it would make the load path self-verifying and stay valid even if
> the build ever moves to an old-glibc sysroot.

The one carve-out is the `sherpa-onnx` speech prebuilt, which already requires
`GLIBCXX_3.4.29` (GCC 11). It loads lazily in the speech worker
(`src/main/speech/stt-worker.ts`), never at app launch, so it is exempt from the
libstdc++ floor — its glibc needs are still checked. Speech-to-text therefore
needs a host with libstdc++ from GCC 11+ (Ubuntu 21.10 / 22.04 LTS or newer); the
app itself still launches on stock 20.04.

## Adding or upgrading a native dependency

- Prefer packages that ship prebuilt binaries compiled against an old toolchain
  (manylinux / `glibc 2.17`-class), like `@parcel/watcher`.
- For a module we compile from source, if the gate flags it, either pin the
  offending symbols the way node-pty does, or build it in an old-glibc container.
- To check locally on a Linux host, list what a binary requires (skipping the
  weak `0x02`-flagged needs the loader tolerates):

  ```bash
  objdump -p path/to/module.node | sed -n '/Version References/,/^$/p'
  ```

  No strong `GLIBC_` node may exceed `2.31`, and no `GLIBCXX_`/`CXXABI_` node may
  exceed `3.4.28`/`1.3.12` — what stock Ubuntu 20.04 ships.
