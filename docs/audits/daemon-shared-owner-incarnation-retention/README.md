# Shared daemon owner incarnation retention

A degraded daemon provider creates two owner resolvers with one shared route map. On an authenticated daemon identity change, the attach resolver removes that daemon’s routes first. The liveness resolver then sees no corresponding routes and previously left its private session-to-incarnation entries behind. Repeating replacements with newly discovered session IDs grows that private map for the lifetime of the degraded provider.

The fix removes private incarnation entries whose shared route is absent after provider invalidation. It preserves every remaining route, including another provider’s live session and a same-ID successor. It does not change process liveness, stop remote work, change the wire protocol, or depend on a git workspace.

## Actual ownership and trigger

- `src/main/daemon/daemon-provider-init.ts:123` selects `DegradedDaemonPtyProvider` for `degraded-new-pty-fallback`; startup discovery runs at line 139.
- `src/main/daemon/degraded-daemon-owner-recovery.ts:15` constructs both resolvers with the same map; public discovery and liveness probes populate their private indexes. Startup reconciliation can also record both routes.
- `src/main/daemon/degraded-daemon-owner-recovery.ts:70` subscribes to each daemon’s identity publication and invalidates the attach resolver before the liveness resolver.
- `src/main/daemon/daemon-pty-connection-lifecycle.ts:41` publishes only after a different authenticated identity replaces a previous identity. Repeated observation of the same identity does not retire anything.
- `src/main/daemon/daemon-pty-daemon-recovery.ts:268` can replace the daemon while retaining its adapter and the degraded provider.
- `src/main/daemon/daemon-session-owner-resolution.ts:44` performs the invalidation and the new private-metadata prune.

This is a local desktop main-process degraded-provider path. Loss of SSH contact is not its retirement trigger. Entry counts below do not establish retained bytes, RSS, an OOM, or causation for #19831.

## Bounded actual-source proof

The fixture uses the actual degraded provider, recovery controller, resolvers, daemon adapter inventory, authenticated identity publication, and direct attach implementation. Only finite authenticated transport replies and the empty fallback provider are inert; it starts no native PTY, socket, network connection, or application window. It does not depend on garbage-collection timing or a never-settling promise.

Each of 32 cycles discovers a new current-daemon session, populates both resolvers through public calls, observes an unchanged identity, then publishes a replacement identity. An unrelated legacy-daemon session remains live throughout. Finally, an ordinary legacy exit removes its route from both resolvers.

| After 32 replacements and the legacy exit | Baseline | Fixed |
| ----------------------------------------- | -------: | ----: |
| Shared routes                             |        0 |     0 |
| Attach resolver incarnation entries       |        0 |     0 |
| Liveness resolver incarnation entries     |       32 |     0 |

Additional assertions preserve a same-ID successor on another provider, an unchanged authenticated identity, direct attach with a matching authoritative incarnation without inventory, refusal of a mismatched authoritative incarnation, and ordinary exit cleanup. The permanent tests include the repetition regression and three compatibility controls; the portable fixture additionally exercises the actual adapter attach transport path.

## Reproduce

Run from the repository root with its dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/daemon-shared-owner-incarnation-retention/reproduce.cjs
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/daemon/daemon-shared-owner-incarnation-retention.test.ts src/main/daemon/daemon-session-owner-resolution.test.ts src/main/daemon/degraded-daemon-pty-provider.test.ts
```

The runner accepts an optional output filename as its first argument. On macOS, the Electron runtime control is:

```sh
ORCA_BACKGROUND_LAUNCH=1 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron docs/audits/daemon-shared-owner-incarnation-retention/reproduce.cjs
```

On Linux or Windows, use the corresponding installed Electron binary with the same environment variables. It runs as Node and never displays a window.

The baseline test overlay reverses only the fenced product patch in memory:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config docs/audits/daemon-shared-owner-incarnation-retention/before.config.mjs src/main/daemon/daemon-shared-owner-incarnation-retention.test.ts src/main/daemon/daemon-session-owner-resolution.test.ts src/main/daemon/degraded-daemon-pty-provider.test.ts
```

Expected: exactly the new repeated-retirement assertion fails before the fix; the other 53 tests pass. All 54 pass with the fix.

## Source identities and publication independence

`sources.cjs` checks the exact fixed source hash, reverses `fix.patch`, checks the baseline hash, and fences every evaluated TypeScript dependency. It records actual evaluated and input hashes and a bundle hash in each report. A CRLF control checks source and patch normalization. The default runner needs neither Git history nor ignored audit notes.

`source-versions.json` records the audited source graph (276 modules) and the independent main graph at `291b4ddd6f1c1af480169885e0fda7f9c78ff053` (274 modules). Both graphs are accepted explicitly; ten surrounding modules differ because of unrelated audit fixes. The proof therefore does not require those fixes to be stacked. The publication reports were produced through the exported `run({ readSource, output, sourceLabel })` API, reading each non-target source from that named main revision and applying only this product change. The default command also runs directly on that publication tree with the fix and artifact installed.

Node 26.6.0 and Electron 43.7.0 / Node 24.21.0 both produced the table above against both source graphs. All four executions used the working installation’s external packages. These are source overlays, not historical application or dependency installations.

At reported v1.4.198 (`e0826956fcfc532f5a1e55b5e081f2e57e553c43`), the resolver, shared recovery controller, and authenticated identity publication match the recorded baseline exactly. The surrounding degraded provider differs, as recorded in `historicalCore`; no whole-v1.4.198 execution or incident attribution is claimed.

`validation.json` records tests, typecheck, full-file artifact quality, and limits. The four result files contain measured entry counts and exact source/artifact identities.
