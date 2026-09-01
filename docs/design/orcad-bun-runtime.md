# Bun-backed orcad

**Status:** design validated by a small macOS/Linux proof; no production cutover.

## Decision

Ship a pinned Bun executable inside each orcad install slot and run both `orcad.js` and the terminal daemon with it. Replace `node-pty` in the daemon with `Bun.Terminal`; do not try to make the current `node-pty` path the Bun contract.

This removes the host Node version and Node ABI from deployment. It also removes the `node-pty` prebuild, libc, compiler, and spawn-helper matrix once the migration window closes.

Use the ordinary Bun executable plus the existing three JavaScript entrypoints, not `bun build --compile`, for the first cutover. orcad needs two independently forked children, versioned daemon adoption, transparent content hashing, and rollback to older JavaScript. A slot-local runtime is easier to inspect and roll back than three compiled executables.

## Measured evidence

| Surface                                                        | macOS arm64                                                                | Real Linux x64 host                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Existing `orcad.js --orcad-smoke-load-check` under Bun         | Bun 1.3.14: pass; this exits before binding RPC                            | not yet exercised                                                                        |
| Runtime SQLite                                                 | `node:sqlite` is absent; `bun:sqlite` adapter round-trip passes            | not yet exercised                                                                        |
| Runtime WebSocket server                                       | listener binds, but `ws` over Bun's `node:http` never completes an upgrade | not yet exercised                                                                        |
| `@parcel/watcher` loads and reports a real file event          | Bun 1.3.14: pass                                                           | not yet exercised                                                                        |
| `Bun.Terminal` spawn/output/exit                               | Bun 1.3.14: pass                                                           | Bun 1.3.13: pass                                                                         |
| Detached `node:child_process.fork` + IPC child outlives parent | Bun 1.3.14: pass                                                           | not yet exercised                                                                        |
| Current `node-pty` under Bun                                   | native loads, child exits, output is lost; an interactive shell hangs      | native loads and output round-trips                                                      |
| Current Node-backed orcad lifecycle                            | previously proven                                                          | 12/12 on a real Ubuntu host, including same-daemon reattach and scrollback after restart |

The macOS `node-pty` result rules out “run the existing addon under Bun” as a portable strategy. A successful native load is not enough; it can silently lose the terminal stream.

Bun's documented platform contract is suitable for Orca's floor:

- one dependency-free executable;
- Linux x64/arm64 glibc binaries require glibc 2.17, below Orca's glibc 2.31 floor;
- musl binaries exist for Linux x64/arm64;
- macOS x64/arm64 and Windows x64/arm64 artifacts exist;
- `Bun.Terminal` uses `openpty()` on macOS/Linux and ConPTY on Windows as of Bun 1.3.14.

Sources: [Bun installation](https://bun.com/docs/installation), [Bun PTY API](https://bun.com/docs/runtime/child-process#terminal-pty-support), [Bun 1.3.14 Windows ConPTY notes](https://bun.com/blog/bun-v1.3.14#bunterminal-on-windows-via-conpty).

## Full-runtime migration POC

The current implementation now has a Bun-native WebSocket transport and Bun.Terminal daemon
backend. A Node CLI can pair to Bun orcad; a Bun orcad can start and reattach its Bun daemon.

Results:

- Bun publishes readiness with a real WebSocket RPC endpoint.
- Node CLI pairing, repo RPC, worktree RPC, terminal creation, input, output, and scrollback work.
- Runtime restart preserves the daemon PID and terminal scrollback.
- `node:sqlite` is absent under Bun; the narrow synchronous adapter uses `bun:sqlite`.
- Static web-client requests are served through the Bun fetch path.
- A legacy Node daemon can still be adopted by Bun orcad; backend identity stays outside the daemon wire.

The POC does not claim production portability yet. Bun's missing read-side PTY pause/resume and
Windows process-job handles remain explicit platform gaps.

## Shipping shape

Each content-addressed install remains self-contained:

```text
orcad-<version+hash>/
  bun                         # bun.exe on Windows
  orcad.js
  daemon-entry.js
  parcel-watcher-process-entry.js
  agent-browser-<platform>-<arch>
  .version
  .install-complete
```

Build and deploy rules:

1. Pin one Bun version and release-asset SHA-256 per supported platform/arch. Never download `latest` during build or activation.
2. Include the Bun executable in `ORCAD_ARTIFACTS` and the content hash. Mark it executable before `.install-complete` is written.
3. Launch `<slot>/bun <slot>/orcad.js`; never consult `PATH` for Bun or Node.
4. Fork children with the same slot-local `process.execPath`. Preserve detached/IPC behavior and the daemon's user-data relocation rules.
5. Report optional `runtimeKind`, `runtimeVersion`, and `ptyBackend` health fields. Keep old health fields readable during skew; absence remains unknown.

The launch command should name a runtime executable rather than `nodePath`. Activation records need an optional per-version runtime descriptor. Its absence means the legacy Node launch path, so rollback can still start an older Node slot instead of incorrectly feeding it to Bun.

| Required behavior                                         | Bun mapping                                                           | State                               |
| --------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| spawn with cwd/env/cols/rows                              | `Bun.spawn({ terminal })`                                             | proven local + Linux host           |
| output                                                    | `terminal.data`, streaming `TextDecoder`                              | proven local + Linux host           |
| input                                                     | `terminal.write()`                                                    | proven local + Linux host           |
| resize                                                    | `terminal.resize()`                                                   | proven local + Linux host           |
| real exit code                                            | `await subprocess.exited`, not terminal `exit`                        | proven                              |
| signal/kill                                               | `subprocess.kill(signal)` plus existing process-tree enforcement      | basic path proven; Windows caveat  |
| foreground process                                        | shell name fallback plus existing PID-anchored process-table resolver | basic path proven; needs agent E2E  |
| POSIX slave path                                          | not exposed by Bun                                                    | shell-ready fallback still needed  |
| pause/resume producer                                     | no Bun API                                                            | release blocker                     |
| Windows per-PTY job membership and exact tree termination | not exposed by Bun                                                    | release blocker                     |
| ConPTY clear/wrap behavior                                | differs from patched `node-pty`                                       | release blocker                     |

### Why pause/resume blocks a default switch

`Bun.Terminal` has `write`, `resize`, `ref`, `unref`, and `close`, but no read-side `pause`/`resume`. Orca negotiates output pause on the terminal stream and currently calls `node-pty.pause()` so a flooding child eventually blocks on the kernel PTY buffer.

Dropping output, buffering without a hard bound, or mapping pause to SIGSTOP would change behavior. SIGSTOP also has no Windows equivalent and pauses computation rather than applying output backpressure. Before defaulting to Bun, either Bun must expose read flow control or Orca must adopt a separately proven bounded strategy that preserves the negotiated output-pause contract on every platform.

### Why Windows needs its own gate

Orca's `node-pty` patch adds per-PTY job ownership, kernel-backed job membership, exact descendant teardown, and ConPTY fixes. `Bun.Terminal` provides ConPTY I/O but does not expose those job handles. A green echo test does not prove close, crash cleanup, detached-child liveness, wide-character repaint, or process-tree ownership.

Windows stays on the legacy daemon until a Bun backend passes the existing native capability oracle and the daemon's real process-tree tests. Do not label handshake coverage as `pty-spawn`.

## Migration without stranding users

No live PTY needs to move between backends.

1. **Additive metadata.** Runtime health now reports optional `runtimeKind`, `runtimeVersion`, and `ptyBackend`; old clients ignore them.
2. **Ship Bun dark.** The Bun runtime and backend are available through explicit Bun smoke commands; production artifact pinning and deploy selection remain separate work.
3. **Canary the orcad process.** Bun orcad now uses a Bun-native WebSocket transport and Bun daemon PTYs while preserving the existing Node transport and daemon protocol.
4. **Preserve live legacy daemons.** A Bun orcad adopts a live legacy Node daemon rather than replacing it; the migration E2E proves the daemon PID and session scrollback remain stable.
5. **Default only after platform gates.** Bun is not yet the production default. Rollback must continue to start each slot with its recorded runtime.
6. **Remove Node/node-pty last.** Keep legacy Node/node-pty support until output backpressure, Windows process ownership, and mixed-version rollback are proven.

Persistent state, pairing credentials, terminal session IDs, daemon socket names, and RPC frames do not change. Backend identity is diagnostic metadata, not a new terminal stream opcode. If a new opcode becomes necessary, capability-negotiate it; unknown opcodes are silently dropped by old decoders.

## Acceptance gates before cutover

- Bundled, checksum-pinned Bun runs on macOS x64/arm64, Linux glibc x64/arm64, Linux musl x64/arm64, and Windows x64/arm64.
- Existing orcad lifecycle E2E passes under Bun: real pairing, PTY, output, graceful runtime restart, same daemon PID, reattach, retained scrollback.
- Old Node daemon + new Bun orcad and new Bun daemon + old Node orcad both pass.
- Output-pause flood test proves bounded memory and no silent output loss.
- Shell-ready/startup-command delivery passes without a PTY slave path.
- Foreground agent detection, sleep, close, crash cleanup, and detached descendants pass on every platform.
- Windows native capability oracle, wide-character repaint, job membership, and exact tree termination pass.
- Activation rollback starts the incumbent with its own runtime and leaves `live` sessions live; loss of contact remains `unverifiable`.
- Real-host deploy installs the slot-local runtime, activates only after `pty-spawn` health, then survives an orcad restart.

## Next implementation slice

Pin and ship Bun executables in remote install slots, then close the remaining PTY parity gates: read-side
backpressure, POSIX slave-path behavior, and Windows job ownership/ConPTY compatibility. Only then remove
the Node/node-pty fallback or change the production default.
