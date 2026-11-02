# Linux clipboard publisher

Orca text copies on native Wayland use `orca-wayland-clipboard` instead of asking
Electron to own the clipboard. A rejected or reused input serial can leave
Chromium returning its own cached text after other applications copy something.
After the helper acknowledges publication, the main process discards that source
and cache. Ordinary UI copies and terminal copies share a bounded queue, preserving
request order even when validation yields.

The helper prefers `ext_data_control_v1`, then `zwlr_data_control_v1`. These
protocols publish without an input serial. It loads the host's
`libwayland-client.so.0` dynamically. GNOME/Mutter does not expose these protocols;
on that desktop the helper loads host GTK 3 and publishes through Xwayland's
clipboard bridge. GTK handles selection conversion and large incremental transfers.
No `wl-copy`, `xclip`, or other clipboard command is required at runtime.

## Upstream issue and removal

This is a temporary workaround for [Electron #54645](https://github.com/electron/electron/issues/54645).
Stock Electron 43.7.9 and 44.7.0 still reproduce the rejected write and stale read.
Remove the publisher after an Electron version containing the upstream repair
passes these checks with the helper disabled on native Wayland:

- Before any keyboard/mouse input, copy A externally, write B through Orca's text
  IPC, then copy C externally. Both the system clipboard and Orca must contain B
  after the write and C after the external copy; native Ctrl+V must paste C.
- Repeat with OSC 52 emitted by a restored terminal before new input, and with
  duplicate/different copies after native keyboard input. Check Unicode, CRLF,
  large text, and later external copies on Mutter, wlroots and KDE.

When these pass, restore the existing Electron writers in `clipboard-ipc-handlers.ts`
and remove the text publisher, executable staging, native directory, build script
and packaging resource/hooks. Keep sender authorization and payload limits.
Do not use Electron's write-then-read result alone to validate the repair: the
affected runtime returns its own rejected text from the cache.

Neither path requests window focus or displays a window. If neither data control
nor the Xwayland/GTK path is available, the copy rejects without retrying through
Electron or changing the existing clipboard. X11, macOS and Windows use their
existing backend, including explicit `--ozone-platform=x11` launches in a Wayland
session. PRIMARY, images, browser-native copy commands and file copies keep their
existing paths; this helper accepts text for the regular clipboard only.

The helper accepts up to 16 MiB of UTF-8 on stdin, publishes, and detaches after
an owner-startup acknowledgement. The owner serves subsequent paste requests and
exits when replaced or disconnected. Data-control transfers are bounded to eight
readers and expire after two seconds without progress. AppImage launches stage a
private, content-addressed executable outside its install directory so AppImage
unmounts and updates cannot invalidate the owner's executable. Its environment
also excludes library paths inside the AppImage mount.

## Building and testing

Linux `pnpm run build`, `pnpm run build:native`, and packaging require Docker
running when no verified cached helper exists. This keeps builds on the supported
library floor rather than linking against a newer development host. Before
running `pnpm dev` on native Wayland, build the helper with `pnpm run build:native`.
macOS and Windows builds do not invoke it. To select a slice directly:

```sh
node config/scripts/build-wayland-clipboard.mjs --arch x64
node config/scripts/build-wayland-clipboard.mjs --arch arm64
```

Builds use Ubuntu 20.04, preserve the glibc 2.31 floor, validate ELF architecture
and library requirements, and cache by source/toolchain fingerprint. Linux
packaging builds the target slice before copying it into
`resources/bin/orca-wayland-clipboard` and validates the copied executable.
Development uses `.build/<arch>/`.

On an executable target architecture, the build runs `protocol_test.py` against
an isolated fake compositor and `x11_test.py` against its own Xvfb server. Coverage
includes both data-control protocols, byte preservation, unsupported desktops,
owner cancellation, bounded stalled receivers, repeated copies, empty text,
Unicode, CRLF and 16 MiB incremental transfers. Cross-built slices still need a
runtime test on their target architecture. The X server and clipboard tools in
the build image are test dependencies only.

Exit codes: 64 invalid arguments, 65 oversized/input failure, 69 unavailable
library/display, 70 publication/protocol failure, 71 owner startup failure, and
78 unsupported compositor. `--probe` checks data-control support only and writes
nothing; it does not probe the GTK fallback.

OSC 52 received from local, folder or SSH terminals uses the publisher on the
**desktop client**, never on the terminal's execution host. This does not fix
agents choosing a server's virtual display instead of emitting OSC 52, nor a
paired connection losing OSC 52 before it reaches the desktop.
