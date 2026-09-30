# WSL guest process cleanup

A Windows PTY job cannot terminate Linux processes inside the WSL VM. Daemon
shutdown therefore runs a separate guest cleanup, concurrently with the bounded
Windows sweep. Neither cleanup completing is proof that every descendant exited.

## Ownership and privilege

Each WSL PTY spawn receives a new random `ORCA_PTY_TREE_ID` UUID. Reusing a terminal
session ID does not reuse this marker. Children inherit it through their environment.

`native/linux-guest-tree-kill/main.c` opens each candidate `/proc/<pid>` directory
once, reads `environ` through `openat` on that descriptor, and matches a complete
NUL-delimited marker entry. Both signals use `pidfd_send_signal` with the retained
directory descriptor. There is no numeric-PID signal fallback: a recycled directory
name cannot redirect an already captured target.

The helper runs as the distro's root user so it can inspect and signal marked
children that changed user, such as `sudo -E` tools. It has one operation: clean up
the supplied marker within a bounded budget. It does not load plugins, interpreters,
user configuration, network code, or a persistent privileged service.

The Windows launcher uses its system WSL executable, clears caller-controlled WSL
environment imports and loader variables, and uses fixed system tools with positional
arguments. The host bounds and verifies the bundled bytes before streaming them over stdin.
Before root execution, the selected bytes are decoded into an exclusively created
private guest directory and checked against the artifact's SHA-256 digest. The
private copy is removed after execution. The cleanup helper is never selected from
PATH or replaced with a user-installed runtime.

## Build and delivery

`pnpm build:guest-tree-kill` uses a checksum-pinned official Zig 0.16.0 distribution
to cross-compile static musl executables for Linux x64 and ARM64. The compiler is a
build-time tool cached outside the shipped payload; it is not installed in the
user's distro. No Python, Node, compiler, or shared-library installation is needed
for the helper itself.

The generated `resources/guest-tree-kill` directory contains both binaries, their
manifest, and redistribution notices. Generated binaries are not committed. Build
and packaging checks reject missing or stale artifacts, hash mismatches, incorrect
ELF architecture, dynamic loaders, and shared-library dependencies. Both guest
architectures ship even with an x64 Windows app, because the WSL guest may be ARM64.

The update-surviving Windows daemon copies these resources as part of its required
manifest and checks their completeness. Its helper must remain available after the
original application installation is replaced; see
[Windows daemon relocation](./windows-daemon-host-relocation.md).

## Bounds and limitations

- The host wait is bounded. The helper separately limits elapsed time, processes
  scanned, environment bytes, and retained descriptors. It reserves escalation time
  and kills captured targets before attempting another scan. Under load the grace
  period can be shorter than two seconds.
- Linux must implement `pidfd_send_signal` for an open proc-directory descriptor
  (introduced in Linux 5.1). Missing or denied kernel support is `unverifiable`, and
  no numeric-PID fallback runs. WSL1 and custom old kernels need capability testing.
- The guest bootstrap needs its standard shell/file/hash tools and access to the
  streamed helper. Missing tools or execution restrictions fail closed rather than
  installing software or changing distro settings.
- A child that removes the marker, including a normal `sudo` invocation that resets
  its environment, is outside this marker-based cleanup. Solving that needs ownership
  tracking established at launch, not a wider shutdown scan.
- A fresh running-distro query skips known-stopped distros. WSL does not provide an
  atomic "execute only if still running" operation here, so a distro can stop between
  the query and launch.
- A host timeout does not prove the guest helper exited. Slow startup or a blocked
  kernel operation can outlive the host wait. Captured handles and per-spawn markers
  keep that delayed cleanup from targeting a later terminal incarnation.
- Linux unit/process tests and cross-compilation are not native Windows/WSL or ARM64
  execution evidence. The repository's existing WSL1 lane cannot establish WSL2
  behavior; native WSL2 validation remains a separate requirement.

The kernel interface and its stable-target guarantee are documented in
[pidfd_send_signal(2)](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).
