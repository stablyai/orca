# Wayland terminal clipboard

Terminal copies on native Wayland use `orca-wayland-clipboard` instead of asking
Electron to own the clipboard. This avoids a rejected input serial leaving
Electron's clipboard cache stuck. After the helper acknowledges its new source,
the main process clears Electron's old source and cache.

The helper uses `ext_data_control_v1`, or `zwlr_data_control_v1` on older
compositors. It dynamically loads the desktop's `libwayland-client.so.0` and
needs no separately installed clipboard command. On desktops without either
protocol, Orca retains Electron's existing clipboard backend. Helper failures
on supported desktops reject the copy rather than retry through Electron.
X11, macOS and Windows retain their existing clipboard backend.

The helper reads UTF-8 bytes from stdin, publishes the selection, and detaches
after a compositor roundtrip and owner-startup acknowledgement. Its owner process serves subsequent paste requests,
survives Orca exit, and exits when replaced or disconnected. Paste requests are
bounded and expire after two seconds without progress so a stalled receiver cannot keep an old owner alive.

## Building

With Docker running, use `pnpm run build:native` on Linux, or build a particular
slice with:

```sh
node config/scripts/build-wayland-clipboard.mjs --arch x64
node config/scripts/build-wayland-clipboard.mjs --arch arm64
```

Builds use Ubuntu 20.04 to preserve Orca's glibc 2.31 floor, validate the ELF
architecture and library requirements, and cache by source/toolchain fingerprint.
Linux packaging builds and verifies the target slice before copying it into
`resources/bin/orca-wayland-clipboard`. Development resolves the same executable
under `.build/<arch>/`.

The build runs `protocol_test.py` when the container can execute the target
architecture. The tests use an isolated fake compositor to cover both protocols,
byte preservation, unsupported desktops, owner cancellation and stalled receivers.
Cross-built slices still require a runtime test on their target architecture.

Exit codes: 64 invalid arguments, 65 invalid/oversized input, 69 unavailable
Wayland library/display, 70 protocol failure, 71 owner startup failure, and 78
unsupported compositor. `--probe` discovers support without writing a selection.

OSC 52 from local, folder and SSH terminals reaches this helper on the desktop
client; no clipboard executable is required on the terminal's execution host.
