# Native PTY spawn environment lifetime

The native PTY handle's exit callback captured its complete creation arguments solely to read `reportsChildExitStatus`. Those arguments include the merged spawn environment. Copying that boolean before registering the callback releases the arguments and environment while the PTY remains live.

This is per-handle retention: the original objects also collect after the handle and native event owner become unreachable. It does not establish retention after every terminal closes, native PTY memory usage, an RSS slope, or the cause of #19831.

## Ownership and compatibility

- `src/main/daemon/pty-subprocess.ts:72–113` creates the environment, completes preflight and native spawn, then passes a fresh object literal to `createDaemonPtySubprocessHandle`. This is the sole production call site; the caller never stores or mutates that object afterward.
- `src/main/daemon/pty-subprocess/native-pty-spawn.ts:29–74` computes `reportsChildExitStatus` synchronously from the selected native launch command. Every successful return copies the boolean into its result. It is an immutable spawn fact in this call chain.
- `src/main/daemon/pty-subprocess/subprocess-handle.ts:26–69` needs the process, projected foreground metadata, scalar exit-status fact and PATH. Its long-lived exit callback previously retained the whole argument object. The fix changes only that capture. Native spawning, native signal ownership, physical-exit ordering, disposal and output buffering are unchanged.
- The environment is a fresh merged object, but many of its string values may already be shared with `process.env`. Releasing its reachability does not imply an equivalent reduction in resident bytes. Required PATH remains reachable through `shellPathEnv`.

`source-versions.json` records exact hashes. Main commit `291b4ddd6f1c1af480169885e0fda7f9c78ff053` exactly matches the audited wrapper baseline. Release `v1.4.198` (`e0826956fcfc532f5a1e55b5e081f2e57e553c43`) has the same environment capture and callers, but predates unrelated I/O-failure and exit-listener ordering changes. The two-line patch applies to both named sources. This is a historical source comparison, not a historical packaged-runtime reproduction.

The change stays inside the daemon's execution-host wrapper. It adds no remote wire data or client-side process verdict, and depends on neither a git worktree nor a folder workspace.

## Bounded before/after proof

`sources.cjs` reverses `fix.patch` in memory and checks the exact baseline and fixed SHA-256 values before bundling either version. It imports the actual foreground tracker and pre-listener queue, and records all effective source dependency hashes and the generated bundle hash. No git refs, copied production implementation, build outputs, credentials or ignored notes are required to rerun it.

Source and patch reads normalize CRLF to LF before reversal and hashing; recorded named-source, dependency and event-emitter hashes use canonical LF. The proof also feeds synthetic CRLF source and patch text into the loader in memory and verifies identical before/after source and hashes, without writing product files. This checks the checkout line-ending case, not a Windows runtime.

The fixture uses the installed `node-pty` JavaScript event emitter and an inert process port. Native termination imports and `process.kill` are guarded; no native PTY, subprocess scan, OS signal, socket or window is created. WeakRefs measure one small argument object and one small environment object, with no payload amplification. The deadline is 15 seconds and the heap limit in these commands is 128 MiB.

| Runtime                        | Live handle before: args / env | Live handle after: args / env | After owner drop, both versions |
| ------------------------------ | ------------------------------ | ----------------------------- | ------------------------------- |
| Node 26.6.0                    | 1 / 1                          | 0 / 0                         | 0 / 0                           |
| Electron 43.7.0 / Node 24.21.0 | 1 / 1                          | 0 / 0                         | 0 / 0                           |

Both versions preserve PATH, startup-delivery metadata, raw foreground lookup, pre-listener output and exit replay, normal exit codes, signal causes, unavailable wrapper status, dead-handle signal guards and idempotent disposal. `node-results.json` and `electron-results.json` contain the measured results.

From the repository root, run the Node proof:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=128 docs/audits/native-pty-spawn-env-retention/reproduce.cjs
```

For Electron, run the installed Electron executable with `--expose-gc --max-old-space-size=128 docs/audits/native-pty-spawn-env-retention/reproduce.cjs`. Set `ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1` in its environment. This keeps Electron in Node mode; it creates no windows.

## Regression checks

The new lifetime regression measures collection before native exit, then confirms that the live handle still delivers data and exit. Two more cases preserve both exit-status interpretations after collection. Existing lifecycle, foreground identity/cadence, environment inheritance and I/O-failure cleanup suites cover neighboring contracts.

The fixed six-file run passed 114 tests with four existing platform skips. The reversible baseline overlay ran the new and existing lifecycle suites: one expected lifetime failure, 29 passing controls. To reproduce the overlay without editing product files:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config docs/audits/native-pty-spawn-env-retention/before.config.mjs src/main/daemon/pty-subprocess-env-retention.test.ts src/main/daemon/pty-subprocess-handle-lifecycle.test.ts
```

`validation.json` records the verification commands and outcomes. The pending-creation cancellation audit is separate and is not changed here.
