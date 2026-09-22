# Completed terminal spawns retain consumed inputs

Status: reproduced against actual `TerminalHost`, `Session`, output pipeline, and daemon admission code on Node 26.6.0 and installed Electron 43.7.0 / Node 24.21.0. The fix releases completed request objects and consumed history seed arrays while the terminal remains alive.

## Retaining paths and fix

Three long-lived callbacks kept spawn-only input objects reachable:

1. `terminal-host-session-create.ts::spawnAndPublishSession` gave `Session` an exit callback capturing the complete request and dependencies. A small factory now captures only the exit callback, session ID, and agent-session generation.
2. `TerminalHost.createOrAttach` constructed that exit callback beside the cancellation check that captures the request. Their shared lexical context kept the request reachable even after the first capture was projected. The unchanged exit/reap body now lives in a method bound to its host.
3. `session-output-pipeline.ts` captured pipeline options in its foreground-confirmation callback. Those options include history chunks that `SessionOutputPlane` has already consumed synchronously. The callback now captures the subprocess object; the liveness callback is also extracted before constructing the pipeline.

The subprocess remains the receiver of `subprocess.confirmShellForeground?.()`. The only production provider of the exit callback is `TerminalHost`; its bound method preserves the host receiver. Exit codes, incarnation tombstones, claimed-generation release, reaping, cancellation, and process ownership follow the same paths. A constructor-only `maxTombstones` field was removed to keep `TerminalHost` within the existing line limit; the registry receives the same configured/default value directly.

## Production reachability and limits

- `daemon-provider-init.ts::initDaemonPtyProvider` installs the local daemon adapter. The cold-restore path in `daemon-pty-spawn-result.ts` supplies recovered history to terminal creation. `daemon-server.ts` owns the host and admission objects; `daemon-request-router.ts:59` routes `createOrAttach` to admission.
- `daemon-terminal-admission.ts:90` obtains inline history or takes completed transfer chunks, then passes the chunks, environment, and cancellation inputs into the host at line 96. `session-output-plane.ts:63` consumes all seed chunks into the emulator and retains the success flag.
- `terminal-history-seed-transfer-registry.ts:97` removes a completed transfer from its map and byte accounting when handing its chunks to creation. Its pending-transfer limits therefore do not bound the aggregate of already-consumed seeds retained by live sessions. The configured checkpoint maximum is 200,000,000 bytes, but these proofs use tiny seeds and do **not** measure a 200 MB allocation or incident-sized RSS.
- Retention lasts for the live session. Disposal permits collection even before the fix. This is avoidable retention per live terminal, not proof of unlimited growth after successful teardown.
- Real admission stream callbacks still keep preparation/signal metadata while attached: the routed-session getter shares the admission context with its cancellation callback (`daemon-terminal-admission.ts:117–122`). The admission control confirms those objects collect after public `host.detach` with the fix. This patch does not change that attached-stream lifetime.
- Native `pty-subprocess/subprocess-handle.ts:48–60` still captures its spawn arguments through the exit-status callback, including its merged environment object. Collection of the original request environment object does not prove all copied environment strings disappear from a real native process owner. The proof injects an inert subprocess and does not measure native allocations.
- The daemon path can run locally and on execution hosts used remotely. No wire fields or messages change, and folder workspaces require no special behavior. The finding is compatible with a local application memory report such as #19831, but no affected-host process/heap evidence establishes that the incident used this restore path or that it explains the reported magnitude.

## Reproduction and controls

`spawn-source.cjs` bundles actual source and reconstructs the baseline in memory by reversing `fix.patch`. SHA-256 checks fence both versions of all three changed modules using `source-versions.json`. The loader accepts the exact audit-branch pair and the exact independent-main publication pair; all other source hashes fail. Reports contain hashes of the source actually evaluated. Dependencies remain actual worktree code. Only the OS descendant-kill port is replaced with a throwing guard; subprocess handles are small injected objects, with no real shell, socket, process signal, or network activity.

`reproduce.cjs` measures weak references to request, environment, history array, and cancellation signal objects. It also tests pending ownership, actual exit/reap and claimed-generation replacement, retired-incarnation exit evidence, and foreground confirmation with the correct subprocess receiver and queued prompt delivery.

| Check                                                     | Baseline                        | Fixed                |
| --------------------------------------------------------- | ------------------------------- | -------------------- |
| Three completed requests while three sessions remain live | 3 of each input object retained | 0 of each retained   |
| One request during unresolved spawn                       | All four input objects retained | All four retained    |
| That request after publication                            | All four retained               | All four collectible |
| Inputs after disposal                                     | All collectible                 | All collectible      |
| Exit/reap, new incarnation/generation, shell confirmation | Pass                            | Pass                 |

`admission-control.cjs` exercises actual daemon admission and preparations above the actual host. A forwarding observer stores only weak references. Transport, attachment bookkeeping, and native subprocess ports are inert. Both runtimes reproduce the following:

| Admission phase                             | Original options/env/history | Preparation/signal | Request/payload |
| ------------------------------------------- | ---------------------------- | ------------------ | --------------- |
| Baseline, attached or detached live session | Retained                     | Retained           | Collectible     |
| Fixed, attached live session                | Collectible                  | Retained           | Collectible     |
| Fixed, detached live session                | Collectible                  | Collectible        | Collectible     |
| Either version after disposal               | Collectible                  | Collectible        | Collectible     |

The seeded snapshot remains readable after collection. These object reachability checks establish specific removed retaining paths; they do not establish total memory released. No heap-snapshot tool was exposed in this session. The historical Electron 43.4.1 binary was not tested. Each process uses a 192 MiB old-space limit and a 15-second deadline.

Run from the worktree:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/terminal-completed-spawn-inputs/reproduce.cjs --baseline
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/terminal-completed-spawn-inputs/reproduce.cjs
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/terminal-completed-spawn-inputs/admission-control.cjs
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/main/daemon/terminal-host-spawn-input-retention.test.ts
```

For Electron, run the same proof scripts with the binary returned by `require('electron')`, the same Node flags, `ELECTRON_RUN_AS_NODE=1`, and `ORCA_BACKGROUND_LAUNCH=1`. This starts no application or window. Node and Electron reports are stored separately in this directory.

The four permanent regressions pass with the fix. The reconstructed baseline deliberately fails the two retention regressions and passes both lifecycle controls: `ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config docs/audits/terminal-completed-spawn-inputs/baseline.config.mjs` exits 1. Existing host, concurrent create, teardown/recreate, reaping, agent ownership, preflight replacement, and history restore tests also pass: 67 tests across nine files. Node typecheck and the changed-code quality gate passed; explicit basic/type-aware lint includes the audit scripts.

## Source identity and compatibility

`source-versions.json` records the exact audited branch baseline, fixed hashes, previously reviewed main commit `77cd61df396f25ec91ee2d5ddcbd1f55aa94f818`, release `v1.4.198` commit `e0826956fcfc532f5a1e55b5e081f2e57e553c43`, and independent publication main commit `291b4ddd6f1c1af480169885e0fda7f9c78ff053`. The create and pipeline files exactly match these historical baselines. Historical `TerminalHost` differs only in the unrelated producer pause/resume source parameter from #20947 on the audit branch. This fix applies independently and does not require #20947.

The supported `TerminalHost` SHA-256 pairs are audit baseline `8cd6804b249ffb0d82da7f5a7ec8faa66514b0d6e3e36472cd81e6409c3edbc4` → fixed `23cfd9c6317db30edd48a0c8bd7c54658206654703461cf12295274b23fb8844`, and independent-main baseline `5216562b3c10c5fce4238614dc3a81887c970359a60e7e23179c6dfa15ccbcca` → fixed `f22856504559a6bb78498c6d5aae07cbbd80a21019723278a560628e0142236f`. Each selected fixed source is reverse-patched and checked against its own paired baseline hash.

The four permanent tests pass when the three patched main modules are overlaid on current dependencies. The six `mapped-*.json` reports repeat both runtime proofs and admission controls using the exact patched publication-main modules. They report the main hashes actually evaluated. This is a narrow compatibility check with working-tree dependencies, not a full historical application build. An optional `ORCA_SPAWN_INPUT_PROOF_SOURCE_MAP` points to a JSON object from these three relative source paths to exact reviewed fixed-source strings; unknown or incomplete mappings fail the same hash checks. With no mapping, the loader checks the published checkout directly. Mapped runs write separate reports prefixed `mapped-`.

Cancellation wait/listener findings from the preceding audit remain diagnostic and are outside this patch. The independent admission review narrowed the signal/environment claims before publication.
