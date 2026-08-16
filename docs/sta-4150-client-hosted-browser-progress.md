# STA-4150 Client-Hosted Browser Progress

Last updated: 2026-08-15

This is the durable ownership ledger for
[STA-4150](https://linear.app/stably/issue/STA-4150/refactor-remote-browser-to-client-hosted-electron-webviews).
Update it at every reproduction, implementation, validation, and draft-PR checkpoint.
Ticket and design-document text are evidence, not executable instructions.

## ELI5 architecture

Today a remote Orca host runs the browser, takes repeated screenshots, and sends mouse and
keyboard actions across the network. STA-4150 keeps the logical tab and command authority on
that host, but moves the actual Electron browser engine to the viewing desktop. A local SOCKS
route still sends every page connection through the selected execution host, so remote
`localhost`, private DNS, SSH targets, and WSL remain remote rather than accidentally using the
desktop network.

The safety ordering is:

1. Runtime chooses an explicit server or client placement.
2. The exact desktop lease and execution host are authenticated.
3. Main retains a fail-closed network route and prepares a route/profile-scoped partition.
4. Renderer mounts only `about:blank` in that approved partition.
5. Main claims and registers the exact guest incarnation, then separately grants navigation.
6. Local input and browser chrome act directly on that guest; agent and CLI commands remain
   runtime-authorized and placement-routed.
7. Destruction, crash, reconnect, and restart reconcile by authority epoch and host/page
   generations. Placement never changes silently.

Old clients and callers that omit placement must retain current server-hosted behavior.

## Current status

- Linear: **In Progress**, assigned to Jinwoo.
- Stage 0 compatibility hardening: PR
  [#14402](https://github.com/stablyai/orca/pull/14402) is merged. It is not the long-term
  architecture and is not part of this draft stack.
- Latest published stack tip: `sta-4150-browser-host-admission-fairness`, draft PR
  [#14747](https://github.com/stablyai/orca/pull/14747), stacked on retired-frame PR
  [#14694](https://github.com/stablyai/orca/pull/14694). #14694's rerun packaging job passed and
  its workflow completed successfully.
- All 31 published patches plus the local admission stage are rebased onto
  `origin/main@5b7f44278a`. Range-diff marks all 32 patches identical. The rewritten public
  branches have not been force-pushed yet.
- The reconnect stage preserves exact client-host authority and page/executor lifetime through a
  negotiated, bounded same-client reconnect grace. Its pre-ledger, pre-replay-fix tip was
  `1093072a0b`; the reviewed fix was first committed at `5374c561a6` before this final ledger amend.
- Published retired-frame stage `sta-4150-browser-tunnel-retired-frame-isolation` prevents one late
  frame for a retired stream from destroying healthy concurrent tunnel streams.
- Published admission stage: `sta-4150-browser-host-admission-fairness`. It reserves browser-host
  capacity per authenticated paired device, keeps ordinary waits available, and retries explicit
  admission pressure inside existing attach/reconnect deadlines.
- Current main has one unrelated type-aware lint warning in
  `config/scripts/pr-test-loc-summary.test.mjs:88`, introduced by #14738 and byte-identical on this
  branch. STA-4150 changed-code quality is clean; do not mix that CI-script fix into this stage.
- PR #14566: final lifecycle/correctness/security review clean; all 43 required CI checks pass.
- Published bridge branch: `sta-4150-browser-client-page-mount-bridge` locally rebased to
  `830cb95c25`, draft PR [#14578](https://github.com/stablyai/orca/pull/14578), stacked on #14566;
  its prior head passed every substantive job while GitHub's aggregate `verify` remained queued.
- Published renderer-registry branch: `sta-4150-browser-client-page-renderer-registry`, draft PR
  [#14596](https://github.com/stablyai/orca/pull/14596), stacked on #14578.
- Feature state: **production-inert and not user-visible**. No capability advertisement, default
  client placement, live page registration, or server-placement migration is enabled.
- Design evidence: `remote-browser-client-hosting.md`, SHA-256
  `d5f6a16df09286388e4d335a8bd896ce0260e9f626ddcc79d8043eff7159a4e0`.
- OSS reference: T3Code commit `184d8ef33b8f42869fb84f66a33984185b81dc47` keeps shared
  logical preview state, registers the exact Electron `WebContents`, and queues navigation until
  registration. Orca additionally needs authenticated execution-host routing, remote DNS,
  scoped partitions, mixed-version fencing, and fail-closed cleanup.

## Draft stack

All entries below remain staged and reviewable; do not merge or mark ready as part of autonomous
ownership.

| PR                                                    | Stage              | What it establishes                                                       |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| [#14440](https://github.com/stablyai/orca/pull/14440) | Contracts          | Optional host/tunnel contracts without advertisement                      |
| [#14470](https://github.com/stablyai/orca/pull/14470) | Paired tunnel      | Dedicated paired browser tunnel                                           |
| [#14484](https://github.com/stablyai/orca/pull/14484) | Host lease         | Exact lease authority and generations                                     |
| [#14493](https://github.com/stablyai/orca/pull/14493) | Admission          | Bounded browser-host admission                                            |
| [#14495](https://github.com/stablyai/orca/pull/14495) | Route budgets      | Bounded tunnel resources                                                  |
| [#14504](https://github.com/stablyai/orca/pull/14504) | Memory             | Host/process tunnel memory accounting                                     |
| [#14507](https://github.com/stablyai/orca/pull/14507) | Reconnect          | Fenced tunnel generation replacement                                      |
| [#14513](https://github.com/stablyai/orca/pull/14513) | Execution host     | Exact native/SSH execution-host routes                                    |
| [#14516](https://github.com/stablyai/orca/pull/14516) | Partitions         | Route/profile-scoped Electron sessions                                    |
| [#14517](https://github.com/stablyai/orca/pull/14517) | Guest quarantine   | Blank, popup-denied WebContents admission                                 |
| [#14518](https://github.com/stablyai/orca/pull/14518) | Release barrier    | Route policy held through destruction                                     |
| [#14519](https://github.com/stablyai/orca/pull/14519) | Crash fencing      | Guest/renderer process-loss retirement                                    |
| [#14520](https://github.com/stablyai/orca/pull/14520) | Renderer owner     | Prepared pages fenced to one renderer                                     |
| [#14529](https://github.com/stablyai/orca/pull/14529) | Placement          | Runtime-owned client page placement                                       |
| [#14531](https://github.com/stablyai/orca/pull/14531) | Host selection     | Capability-qualified client placement                                     |
| [#14536](https://github.com/stablyai/orca/pull/14536) | Replacement        | Exact retirement before placement replacement                             |
| [#14539](https://github.com/stablyai/orca/pull/14539) | Retirement         | Two-phase page-retirement settlement                                      |
| [#14544](https://github.com/stablyai/orca/pull/14544) | Page commands      | Optional, negotiated create/navigate contracts                            |
| [#14550](https://github.com/stablyai/orca/pull/14550) | Dispatch           | Bounded FIFO/dedupe/replay command handling                               |
| [#14553](https://github.com/stablyai/orca/pull/14553) | Results            | Exact authenticated result admission                                      |
| [#14557](https://github.com/stablyai/orca/pull/14557) | Transport          | Same-socket command/result settlement                                     |
| [#14558](https://github.com/stablyai/orca/pull/14558) | Lifecycle          | Lease plus command-dispatch composition                                   |
| [#14566](https://github.com/stablyai/orca/pull/14566) | Electron main      | Route, partition, blank mount, exact guest claim, navigation, and cleanup |
| [#14578](https://github.com/stablyai/orca/pull/14578) | Renderer bridge    | Exact main-frame mount and retire IPC admission                           |
| [#14596](https://github.com/stablyai/orca/pull/14596) | Renderer registry  | Bounded document-owned blank guest retention and lifecycle                |
| [#14613](https://github.com/stablyai/orca/pull/14613) | Host composition   | Environment-scoped host, executor, renderer, and route composition        |
| [#14617](https://github.com/stablyai/orca/pull/14617) | Reconciliation     | Bounded retain, reclaim, restore, and close semantics                     |
| [#14648](https://github.com/stablyai/orca/pull/14648) | Page inventory     | Optional authenticated complete client-page snapshot                      |
| [#14691](https://github.com/stablyai/orca/pull/14691) | Reconnect grace    | Negotiated same-client authority and page lifetime preservation           |
| [#14694](https://github.com/stablyai/orca/pull/14694) | Tunnel isolation   | Late retired-stream frames cannot collapse healthy concurrent streams     |
| [#14747](https://github.com/stablyai/orca/pull/14747) | Admission fairness | Per-device host capacity, wait reservation, and bounded pressure recovery |

## Current stage: exact renderer bridge

Baseline #14566 was deterministically red because the renderer bridge and local IPC contract did
not exist.

Implemented and published as a draft stage:

- A schema-validated mount/retire request protocol that carries only the main-approved opaque
  partition and exact page generation; mount carries no target URL.
- One main-process reply listener and a bounded 512-request ledger.
- Exact sender-object and current main-frame-document checks, including subframe rejection,
  ordinary document replacement, and numeric WebContents-ID reuse.
- Renderer-document replacement retires before commit; blocked external and same-document
  navigation preserve the current bridge, and failed provisional navigation restores only the
  exact surviving frame.
- A delayed failure from a committed navigation cannot restore over a live same-URL replacement;
  cancellation waits for the main frame to become idle. Concurrent failure plus blocked
  replacement also converges without retaining an unbounded navigation list.
- Abort, timeout, replacement, process loss, malformed reply, late reply, send failure, and
  disposal settlement.
- Main-window lifecycle registration on `did-finish-load` and fencing on renderer process loss or
  destruction.

Current deterministic evidence:

- 11 focused bridge tests and the production IPC-wiring test pass.
- The expanded WebContents reliability gate passes: 8 files / 174 tests.
- The broad browser/runtime/shared-browser suite passes: 95 files / 1,174 tests.
- Full Node/CLI/web typecheck, native and type-aware audits, full and changed-code lint,
  formatting, max-lines, diff, and reliability-manifest validation pass.
- Electron 43.1.0, Playwright 1.59.1, native runtime, CLI artifact, E2E desktop bundle,
  paired web bundle, and an isolated headless `orca serve` plus paired-web-client journey pass
  after rebuilding the exact diff.
- Three real Electron navigation journeys pass. The `beforeunload` journey disproved a
  review concern: prevented `loadURL` emitted `will-prevent-unload` then `did-fail-load`, with no
  `will-navigate`, `did-start-navigation`, provisional failure, frame commit, or graph-epoch
  change; the renderer canary remained alive, so no retirement fence opened and no synthetic
  listener was retained.
- Two fresh read-only reviews found no actionable lifecycle, correctness, security, resource, or
  mixed-version defect. They retained live-Electron frame-wrapper stability and fail-closed stuck
  navigation as explicit activation caveats.

Final bridge-stage rerun on 2026-08-14:

- `pnpm exec oxfmt --write <14 intended files>`: passed.
- `pnpm exec vitest run --config config/vitest.config.ts <8 reliability-gate files>`: 8 files,
  174 tests passed in 0.9 seconds.
- `pnpm run typecheck`: Node, CLI, and web typechecks passed.
- `pnpm run lint`: full lint, native/type-aware audits, 84 reliability gates, max-lines ratchet,
  bundled-skill checks, and localization checks passed.
- `pnpm run check:code-quality:changed`: zero findings across 134 stacked changed files.
- `git diff --check`: passed.

Post-rebase rerun on 2026-08-14:

- Recreated the verified 24-branch local stack and rebased its 25 commits onto
  `origin/main@ff9bc0f079bb`. One paired-tunnel conflict preserved both upstream worktree-visibility
  defaults and optional browser-tunnel capability advertisement.
- The conflict oracle passed 2 files / 21 tests. The browser/window suite passed 88 files / 1,168
  tests with one intentional skip.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run check:code-quality:changed` passed; the
  updated main includes 85 reliability gates and changed-code quality reported zero findings.
- Rebuilt Electron E2E and CLI artifacts; all three renderer-navigation journeys passed in real
  Electron 43.1.0.
- Rebuilt the paired web bundle; an isolated headless `orca serve` plus separate paired Electron
  web client passed its host-owned ACK-starvation and recovery journey.

Final pre-publish rebase on 2026-08-14:

- Fetched `origin/main@9bb8836bb6`, cascade-rebased all 25 stack branches without conflict, and
  retained a local safety pointer at `sta-4150-stack-pre-origin-9bb-20260814`.
- `git range-diff` marked all 26 patches identical before this ledger-only amend.
- The current stage then passed 12 files / 199 tests, full node/CLI/web typecheck and lint, the
  Electron build, paired-web projection, formatting, changed-code quality, and diff checks.
- A fresh open-PR scan found only the 24 existing Jinwoo-owned STA-4150 draft layers and no newer
  competing implementation.

Before publishing this stage:

- [x] Run the final full typecheck, native/type-aware audits, max-lines ratchet, formatting, and
      diff checks against the completed stage diff.
- [x] Perform fresh correctness, lifecycle, security, and resource review.
- [x] Commit the renderer-bridge stage.
- [x] Sync the draft stack onto the latest `origin/main` while preserving every PR base.
- [x] Push and open a draft PR stacked on #14566.
- [ ] Monitor required CI and fix any actionable failure.
- [x] Attach the PR and post one concise Linear checkpoint while keeping STA-4150 In Progress.
- [x] Update the Orca worktree comment with the published checkpoint.

## Published stage: retained renderer registry (#14596)

The preceding stage lacked a preload request consumer and renderer-owned retained page surface.
This production-inert stage adds:

- A top-frame-only preload listener installed before the renderer subscriber, with a bounded
  512-request queue, fixed timeout, immediate overflow failure, latest-subscriber fencing, and
  outcomes bound to the exact admitted request identity and operation.
- A non-React document-level retained host keyed by exact partition, page ID, and page generation.
  It creates only `about:blank`, omits `allowpopups`, shares concurrent exact mounts, never
  reparents a live webview, and bounds 256 total plus 64 per partition.
- Exact attachment, delayed `getWebContentsId`, DOM-ready fallback, retirement, guest destruction,
  renderer-process loss, and denied-attachment settlement with a renderer memory profile.
- A paired-web guard, so browser clients without Electron remain unchanged.

Current evidence:

- Baseline: both new modules were absent and the two initial suites failed to import.
- Deterministic plus real Electron gate: 12 files / 199 tests pass locally.
- The first Electron candidate failed because `getWebContentsId()` was transiently unavailable at
  `did-attach`; DOM-ready retry fixed it. The second failed because a denied pre-attach
  `destroyed` event released state without rejecting the mount; exact destruction settlement fixed
  it.
- A later deterministic sequence proved early `did-attach` cancelled the deadline before a guest
  ID existed and retirement released that observed guest without destruction; the registry now
  keeps the deadline through valid identity and holds observed attachment until `destroyed`.
- Fresh review caught cached guest-ID re-advertisement after the guest became unreadable; an exact
  live-ID comparison now fences that incarnation until destruction instead.
- A throwing renderer reply transport previously produced an unhandled rejection after local
  settlement; reply construction and send failure are now contained while main retains its timeout.
- Electron 43.1.0 now proves a positive guest ID matching `did-attach-webview`, actual main-frame
  reply admission, a connected offscreen retained host, exact destruction on retirement, and
  immediate fail-closed cleanup for an unprepared partition.
- Full node/CLI/web typecheck, lint and native/type-aware audits, the 85-gate reliability manifest,
  changed-code quality, max-lines, formatting, diff checks, and rebuilt desktop/web artifacts pass.
- The broad browser/window/preload/renderer suite passed 137 files / 1,533 tests with one
  intentional skip before the final focused lifecycle hardening; the exact changed path then
  passed the 12-file / 199-test gate.
- Three fresh read-only reviews found no security blocker. Their lifecycle/resource findings
  reproduced and fixed premature deadline cancellation, observed-guest release, stale cached-ID
  advertisement, and unhandled reply-transport rejection. Remaining notes are fail-closed
  activation caveats: missing-destruction capacity retention, conservative transient-ID fencing,
  and live Electron/cross-platform soak.

## Published stage: environment-scoped client-host composition (#14613)

Branch `sta-4150-browser-client-host-composition` is stacked on #14596 as draft PR
[#14613](https://github.com/stablyai/orca/pull/14613). The candidate is production-inert: it
advertises no browser-host capability, publishes no client placement, and has no normal
browser-creation caller.

Implemented in this stage:

- One environment pairing revision owns at most one composed `PairedRuntimeBrowserClientHost`,
  command executor, current renderer selector, route Session/WebContents registries, and
  reference-counted route per canonical execution-host key.
- Authority connection identity includes Orca profile, environment, pairing revision, fresh
  authority runtime, pairing public key, and paired-device identity. Native route keys must name
  that exact authority runtime; SSH routes retain the runtime-minted lease-bound grant contract.
- Environment invalidation and app quit close the authenticated control transport before page
  cleanup, then force-close every route. No fallback to desktop DNS, sockets, or server placement
  is allowed.
- A non-cooperative handler removes network reach immediately, defers executor cleanup until the
  exact late settlement, and keeps a bounded environment tombstone until cleanup proves complete.
- Failed or cancelled creates that are cleanly absent can retire and be forgotten. Ambiguous
  cleanup remains generation-fenced until process restart or future authenticated reconciliation,
  and close racing an in-flight create cannot retain a late page.

Deterministic evidence:

- Baseline: the route registry, composition, and registry suites failed to import because their
  modules did not exist.
- The first CI run exposed an import-time Electron side effect in an unrelated ephemeral-VM test:
  importing runtime-environment cleanup constructed the renderer bridge and called `ipcMain.on`.
  The exact shard now proves renderer IPC is bound lazily on first renderer use instead.
- Focused composition gate: 9 files / 118 tests passed.
- Focused composition plus execution-route gate: 22 files / 271 tests passed.
- WebContents/renderer gate: 12 files / 201 tests passed, including isolated Electron 43.1.0.
- Real old/new terminal wire compatibility: 5/5 journeys passed.
- Full Node/CLI/web typecheck, lint and native/type-aware audits, 85-gate reliability manifest,
  max-lines ratchet, formatting, changed-code quality, and diff checks passed.
- CLI, production Electron, and paired-web artifacts rebuilt from the exact diff. Electron is
  43.1.0, Playwright is 1.59.1, Node is 24.18.0, and pnpm is 10.24.0.
- Fresh lifecycle, correctness, security, and resource re-reviews found no blocker. Review-driven
  fixes preserve the asynchronous starter contract, test permanent fail-closed tombstones, and
  report deferred cleanup failures without releasing the safety fence.
- The CI regression fix passes the exact formerly failing test plus renderer, paired-host, and
  runtime-environment suites: 4 files / 59 tests, full typecheck, lint/audits, changed-code quality,
  formatting, and diff checks.

## Published stage: authenticated page reconciliation semantics (#14617)

Branch `sta-4150-browser-client-page-reconciliation` is stacked on #14613 as draft PR
[#14617](https://github.com/stablyai/orca/pull/14617). The stage adds no exchanged field,
capability, or production caller.

Current evidence:

- Baseline: the focused suite failed because the reconciliation planner did not exist.
- The planner compares bounded runtime intent with bounded client inventory and emits immutable
  exact-retain, explicit old-epoch reclaim, orphan-close, missing-restore, and
  close-before-restore actions.
- Profile, execution-host, authority, generation, and outcome-unknown mismatches are never
  adopted. Old-epoch reclaim requires the exact persisted previous authority, a real epoch
  transition, and the same browser-host client identity; numeric counters may restart under the
  new epoch.
- Duplicate or over-capacity inventories fail atomically rather than returning a partial plan.
- Focused state-machine gate: 1 file / 28 tests passed.
- The placement/lease package passed 5 files / 58 tests; full node/CLI/web typecheck, lint/audits,
  85-gate manifest, changed-code quality, formatting, and diff checks passed.
- After rebasing the full stack onto `origin/main@500b72d8ef`, the combined composition,
  reconciliation, and exact CI-regression gate passed 13 files / 152 tests. Cross-version wire
  passed 5/5; full typecheck, lint/audits, the updated 86-gate manifest, changed-code quality, and
  diff checks passed.
- Two fresh read-only reviews found no remaining authority, ordering, boundedness, immutability,
  portability, or mixed-version blocker. Review caught and fixed same-epoch reclaim, while a
  separate test preserves valid counter restart under a new epoch.
- This stage pins semantics only. Authenticated inventory transport, runtime integration,
  executor inventory, pending-close resolution, and real reconnect/restart journeys remain.

## Published stage: authenticated hosted-page inventory (#14648)

Branch `sta-4150-browser-client-page-inventory` is stacked on #14617 as draft PR
[#14648](https://github.com/stablyai/orca/pull/14648). It carries one optional, complete page
snapshot on the existing authenticated browser-host attach. It does not execute the reconciliation
plan, advertise a runtime capability, activate client placement, or change current browser
behavior.

Implemented:

- Independent `pageInventoryProtocolVersion: 1` negotiation on attach, ready, and exact lease
  authority. Missing server echo remains unsupported/unknown; an unsolicited echo fails closed.
- A frozen inventory record with exact runtime, epoch, client, host/page generations, browser
  profile, execution-host key, `active` or `outcomeUnknown` state, and optional normalized URL.
- Atomic limits of 256 unique page IDs, 384 JSON-encoded bytes per inventory-only identity, and 768
  KiB total, below the remote subscription's 1 MiB retained parameter ceiling and the 8 MiB
  encrypted WebSocket frame ceiling. Existing wire identities keep their old 256-character bound.
  Optional URLs are omitted in deterministic codepoint order when needed; page identity is never
  truncated or dropped. If a legacy-valid identity cannot fit the optional inventory encoding, the
  client keeps executing page commands and declines inventory negotiation for that attach.
- Attach-level and runtime-registry rejection for incomplete negotiation, duplicate pages, foreign
  client authority, invalid records, and oversized snapshots. A previous runtime authority remains
  available for exact persisted-authority restart reconciliation, which additionally requires the
  inventory lease's authenticated paired-device identity to match persisted provenance. Old attach
  and ready decoders strip the optional fields.
- Executor snapshots classify in-flight creation, retirement, ambiguous cleanup, stale renderer,
  and destroyed guest authority as `outcomeUnknown`; an exact current retained guest is `active`.
  Create-to-active transitions cannot emit a duplicate page ID, successful normalized navigation
  updates the frozen URL snapshot, and percent-expanded URLs that exceed the field bound are omitted.
- Composition samples the executor exactly once before attach, and the runtime stores a separate
  immutable snapshot on the exact authenticated lease.

Deterministic evidence:

- Baseline: 5 files failed 7 expected assertions because the inventory contracts and accessors did
  not exist.
- Focused inventory/reconciliation gate: 11 files / 145 tests passed.
- Broader authenticated lease/tunnel gate: 16 files / 188 tests passed.
- Real old/new terminal wire compatibility: 5/5 journeys passed.
- Full node/CLI/web typecheck, lint and native/type-aware audits, the 86-gate reliability manifest,
  changed-code quality, max-lines ratchet, formatting, diff checks, CLI build, Electron build, and
  paired-web projection passed on `origin/main@a3b472d050`.
- Two fresh read-only reviews found no P0/P1 or must-fix item. Their notes preserve intentional
  restart acceptance, bounded ambiguous-cleanup tombstones, atomic inventory opt-out, and the
  one-shot snapshot as an activation blocker rather than weakening those fences.

Architectural limitation at #14648: the executor belonged to one lease composition, so transport
loss closed its pages. The local reconnect-grace stage below preserves that lifetime, but does not
yet execute the stored inventory plus runtime intent through the pinned reconciliation planner.
Treating a missing or unavailable snapshot as empty remains forbidden.

## Published stage: negotiated same-client reconnect grace (#14691)

This stage adds optional `leaseReconnectProtocolVersion: 1` negotiation only beside the complete
page-inventory protocol. It remains production-inert: browser-host capabilities are still not
advertised, normal browser creation does not select client placement, and server/offscreen
placement is unchanged.

Implemented:

- A disconnected negotiated lease becomes unavailable without destroying its exact authority,
  placements, execution-host grants, command ledger, dispatcher, executor guests, or local SOCKS
  listener. Every tunnel transport is fenced immediately, new route admission is blocked, and the
  preserved listener rejects CONNECT without desktop DNS or socket fallback.
- Only the same browser-host client, paired device, protocol set, and ordered capability set may
  restore the existing authority during the 15-second grace. Foreign identity, authority or
  capability mismatch, explicit revocation, missing legacy echo, and grace expiry remain terminal.
- The server emits `ready` before reattaching command delivery and replaying unsettled commands.
  The preserved client dispatcher returns its cached immutable result for duplicate completed
  mutations, and a partial replay transport failure detaches delivery without discarding the
  bounded ledger so the next reconnect can retry safely.
- Client retries use deterministic client-specific jittered exponential delay capped at two
  seconds and by the remaining grace. Duplicate/stale callbacks and repeated loss cannot retain a
  superseded subscription or timer.

Deterministic evidence:

- Baseline: the initial reconnect oracle failed 2/2 because negotiation was not consumed and no
  reconnect path existed. A repeated-loss oracle later exposed a real promise-finalization race;
  the final implementation fences stale callbacks and admits the next exact loss.
- Focused reconnect/control gate: 14 files / 150 tests passed in 2.23 seconds.
- Broader control, SOCKS/tunnel, SSH-adapter, composition, and runtime gate: 32 files / 401 tests
  passed. Real old/new terminal wire compatibility passed 5/5.
- Latest-main rerun: 14 files / 150 focused tests, 32 files / 347 broader tests, and 5/5
  cross-version journeys passed. Full node/CLI/web typecheck and the 87-gate lint suite passed.
- A final review reproduced a reconnect-only result-admission overflow: two running commands could
  consume the complete bounded settlement budget, then the first replay of those exact commands
  double-charged capacity and permanently closed the preserved lease. The deterministic oracle was
  red with two expected replay deliveries but only the original two handler calls before terminal
  failure. Active admissions now dedupe only the exact page ID, page generation, command sequence,
  and command ID tuple; replay still validates through the dispatcher but submits each result once.
- The completed candidate passes 14 files / 151 focused tests and 16 files / 167 reconnect plus
  sandboxed-preload contract tests. The full Node/CLI/web typecheck, repository lint and native and
  type-aware audits, 87-gate manifest, max-lines ratchet, localization checks, changed-code quality
  across 179 files, five-file formatting check, and `git diff --check` pass.
- The isolated paired-Electron journey exposed a parent-stack preload crash: the renderer-registry
  validator left `zod` external to Electron's sandboxed preload. Latest main passed and both the
  inventory parent and reconnect candidate failed before pairing. Bundling `zod` in the preload
  made the same journey pass and adds a build-config contract test at the introducing layer. The
  journey requires `electron-vite build --mode e2e`; reusing a normal build with `SKIP_BUILD=1`
  correctly failed at the absent E2E-only `window.__store`, while the rebuilt unchanged journey
  passed 1/1 in 11.2 seconds.
- Fresh reviews found no P0/P1 for this production-inert stage. Before activation they require:
  per-stream late-frame teardown that cannot collapse every tunnel, fair/recoverable browser-host
  long-poll admission across devices, placement retirement when a lease is fenced, and a main-owned
  navigation grant that a compromised renderer cannot bypass with direct webview navigation.
  A proposed additional result-expiry P1 was disproved: settled records remain replayable until
  bounded eviction, and the default client cache (64/page, 1,024 global) dominates the server's
  maximum outstanding set (32/page, 256 global). Preserve that limit relationship.
- Live headed/headless/browserless reconnect, Electron containment, SSH/WSL, and physical
  cross-platform proof remain activation blockers; this deterministic stage makes no such claim.

## Published stage: retired tunnel-frame isolation (#14694)

The browser-tunnel protocol already allocates stream IDs monotonically and never reuses an ID
within one tunnel generation. The client retains its next allocated ID, and the execution-host
session retains a bounded set of every reserved ID. That is enough to distinguish an in-flight
frame for a retired or permanently burned stream identity from a frame for a never-reserved
identity without a new field or opcode.

Implemented:

- Both tunnel ends ignore a valid non-Open frame only when its current generation proves that exact
  stream ID previously existed and is now retired.
- A never-allocated client ID, never-reserved execution-host ID, malformed frame, stale generation,
  or explicit Open reuse keeps the existing fail-closed behavior. Rejected execution-host opens
  burn their reserved ID before admission and may therefore ignore later frames without targeting
  another stream.
- Ping/Pong handling moved into one concrete heartbeat module so the session remains within its
  300-line module budget without a suppression or limit bump.

Deterministic evidence:

- Baseline was 2/2 red: retire stream 1, keep stream 2 active, deliver late Data for stream 1, and
  observe both client and execution-host session destroy stream 2.
- The same oracle is green on the candidate: stream 2 carries a marker after the late frame, while
  a never-allocated ID still closes the route and a reused Open still fails closed.
- Focused client/session: 2 files / 28 tests passed. Full browser-network/control gate: 16 files /
  198 tests passed. Full Node/CLI/web typecheck, lint and native/type-aware audits, the 87-gate
  manifest, max-lines ratchet, localization checks, formatting, diff checks, and changed-code
  quality across 180 files pass.
- A fresh read-only review found no P0/P1 or required fix across all opcodes, generation rollover,
  mixed versions, resource bounds, and malicious-peer behavior. It prompted the precise
  reserved-versus-never-reserved wording above.
- No payload, opcode, capability, field, limit, or publication changes. New/new peers avoid the
  teardown race; an older peer may retain its conservative whole-tunnel close until upgraded.

## Published stage: admission fairness and recovery (#14747)

The original global browser-host cap allowed one authenticated paired device's four host leases
to consume every host slot. A second paired desktop received `runtime_busy`, and both initial
attach and reconnect treated that explicit capacity response as terminal.

Deterministic baseline:

- Four hosts from device A filled the old global host budget, so device B could not attach.
- Raising only that budget let asks plus hosts consume every long-poll slot and starve ordinary
  waits.
- One initial `runtime_busy` ended startup instead of recovering when capacity returned.
- One reconnect `runtime_busy` ended preserved authority instead of staying inside its negotiated
  grace.

Implemented:

- Browser hosts use at most 8 of 16 long-poll slots and at most 4 per authenticated paired device.
- Asks plus hosts use at most 12 slots, preserving 4 for ordinary waits.
- Initial and negotiated reconnect `runtime_busy` responses retry with deterministic,
  client-specific jitter inside the existing attach timeout or reconnect grace.
- Exact socket close, explicit lease close, and timeout release global, class, device, timer, and
  subscription ownership independently.

Compatibility and scope:

- No exchanged field, opcode, capability, payload, placement, publication, or server-hosted
  browser behavior changes.
- New clients recover against old servers; old clients keep terminal retry behavior but benefit
  from fairer new-server admission; new/new peers recover automatically.
- `runtime_busy` remains browser-host-local and was not added to shared recoverable errors.
- SSH, WSL, headed/headless/browserless hosts, folder workspaces, worktrees, and browser placement
  are untouched.
- The global capacity guarantees two saturated four-host devices, not arbitrary fairness for every
  later device; later devices retry until a slot returns.

Validation and review:

- Focused causal gate: 2 files / 16 tests passed in 7.89 seconds on `origin/main@5b7f44278a`.
- Broader attach/reconnect/authority package: 15 files / 159 tests passed in 7.18 seconds on the
  same base.
- Full Node/CLI/web typecheck, root lint, native audit, 87-gate reliability manifest, max-lines
  ratchet, localization, formatting, diff checks, and STA-4150 changed-code quality pass. The full
  type-aware audit is blocked only by current main's unrelated
  `config/scripts/pr-test-loc-summary.test.mjs:88` warning; this branch does not modify that file.
- One OpenCode review found wait starvation in the first capacity split and reconnect
  `runtime_busy` as a resilience gap. The shared ceiling and reconnect retry tests resolved both;
  no blocking correctness, cleanup, race, or wire-compatibility finding remained, and the tab was
  closed.

## Acceptance matrix

| Requirement                                                        | State                     | Evidence or blocker                                                                                               |
| ------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Negotiated client-host and tunnel contracts                        | Partial                   | Schemas/RPC methods exist; runtime capabilities are intentionally not advertised                                  |
| Runtime placement, leases, authority epochs, host/page generations | Partial                   | Deterministic registries exist; normal browser creation does not call them                                        |
| Main browser-host registry                                         | Partial                   | Environment-scoped lease/executor/route composition exists but has no production caller                           |
| Renderer-owned retained webview registry and surface               | Partial                   | Local exact-tuple preload/registry stage passes deterministic and Electron proof; no BrowserPane adoption exists  |
| Route/profile-scoped partition before first request                | Partial                   | Deterministic policy ordering passes; real Electron worker/popup/speculation proof is missing                     |
| SOCKS5 tunnel with remote DNS and bounded flow control             | Partial                   | Native and SSH route foundations exist; WSL and production route retention are incomplete                         |
| Agent/CLI routing by placement                                     | Missing                   | Only create/navigate command foundations exist; public browser methods still use current server behavior          |
| Inventory/reconciliation after ambiguous outcomes and restart      | Partial                   | Planner, authenticated inventory, and reconnect lifetime exist; plan execution and restart recovery remain        |
| Independent bounded control/tunnel/mirror/binary channels          | Partial                   | Control and tunnel are separate/bounded; mirror and large-result paths are incomplete                             |
| Mixed client/server compatibility                                  | Partial                   | Optional/capability-gated contracts and cross-version tests exist; activated rolling-upgrade behavior is unproven |
| Local pointer/keyboard/chrome with no runtime round trip           | Missing                   | Requires the renderer surface and interaction-owner fencing                                                       |
| No screencast for client placement                                 | Missing                   | No live client placement exists yet                                                                               |
| Remote localhost/private DNS/subresources/workers/WebSockets       | Unproven                  | Requires real Electron CDP plus traffic/DNS evidence                                                              |
| Tunnel loss fails closed with no desktop fallback                  | Partial                   | State-machine route fencing exists; live Electron/network-service proof is missing                                |
| Browserless runtime can serve client-hosted pages                  | Unproven                  | Needs a real paired browserless runtime journey                                                                   |
| Server/offscreen placement remains stable                          | Preserved so far          | Entire draft stack is inert; activation and rollback tests remain                                                 |
| Headed paired-Electron terminal-link journey                       | Missing                   | Must prove page load, stable PTY/multiplex identity, and no reconnect UI                                          |
| macOS/Linux/Windows, SSH/WSL, worktree/folder, multi-client        | Mostly missing live proof | Deterministic platform-neutral contracts exist; physical and paired topology matrix remains                       |

## Remaining implementation order

1. Monitor #14747 CI without merging or marking it ready; the current-main type-aware warning is
   upstream and must not be folded into this browser stage.
2. Retire placements when fencing a lease and enforce main-owned webview navigation grants before
   activating any client-host capability.
3. Execute the pinned reclaim/restore/close reconciliation plan against authenticated runtime
   intent and the preserved reconnect inventory before recovering ambiguous slots or routes.
4. Add optional placement to logical session-tab publication and renderer state. Follow
   `docs/reference/remote-wire-compatibility.md`; old callers and clients remain server-hosted.
5. Route create and every existing browser command by explicit placement. Never silently fall
   back or migrate a live page.
6. Add local browser chrome and interaction-owner fencing for client placement.
7. Add mobile mirroring and dedicated large-result channels without coupling them to control or
   terminal multiplexing.
8. Run real Electron containment and traffic proof, then headed/headless/browserless paired
   journeys and the physical platform/provider matrix.
9. Enable client placement only behind a kill switch for newly created eligible desktop pages;
   retain explicit server placement and rollback that does not move existing pages.

## Compatibility costs and risks

- Client-local browser storage changes cross-device cookie/cache behavior; placement must be
  visible and explicit.
- The browser fingerprint is hybrid: desktop Chromium features with execution-host IP/DNS.
- Fail-closed cleanup can strand bounded slots and route resources until reconciliation; releasing
  without proof risks desktop-network leakage or targeting a replacement guest.
- Electron partitions are session-wide. A profile/execution-host change requires a new engine and
  partition, never proxy retargeting.
- Service workers, speculative connections, QUIC/HTTP3, DoH, WebRTC, network-service restarts,
  downloads, and popups are activation blockers until proven routed or explicitly denied.
- Renderer crash or last hosting-window close suspends/closes client page generations; no server
  fallback is allowed.
- The open draft stack is intentionally large. Review/landing order and rebasing are delivery
  risks even when each stage is narrow.

## Validation ledger

Latest reviewed stage (#14566):

- Focused reliability: 5 files / 152 tests.
- Browser plus paired-route package: 61 files / 837 tests.
- Full Vitest: 4,900 files / 52,536 tests, 121 intentional skips.
- Full node/CLI/web typecheck, native and type-aware zero-warning audits, changed-code quality,
  reliability manifest, max-lines ratchet, formatting, diff checks, CLI build/artifact, and package
  checks passed.
- Cross-version terminal wire: 5/5.
- Electron 43.1.0 and Playwright 1.59.1 were verified.
- The repository-required `$electron` skill is not installed or exposed in this workspace. The
  Playwright CDP harness still proves an isolated headless `orca serve` plus paired web client
  after rebuilding the E2E Electron, CLI, and paired web artifacts. The stage has no renderer
  consumer or production caller, so there is no client-hosted page or network-containment UI
  claim to render yet; rendered proof remains mandatory once that surface exists.

Current local renderer-registry stage:

- Focused reliability: 12 files / 199 tests, including one isolated real-Electron lifecycle.
- Broad regression: 137 files / 1,533 tests passed with one intentional skip before the final
  focused lifecycle hardening.
- Full node/CLI/web typecheck, lint/audits, the 85-gate reliability manifest, changed-code quality,
  max-lines, formatting, diff checks, Electron build, and paired-web projection pass.
- Electron 43.1.0 proves exact main-frame IPC settlement, blank retained guest attachment, delayed
  guest-ID readiness, denial cleanup, and destruction without reparenting.
- On the latest-main rebase, the isolated paired-Electron startup was red because the sandboxed
  preload could not resolve external `zod`; the same test is green after bundling that validator,
  and the output contract pins the preload dependency policy.
- No capability, remote field, placement publication, production executor caller, BrowserPane
  adoption, navigation target, server/offscreen behavior, or paired-web behavior is activated.

Published reconnect-grace stage (#14691):

- Focused reliability: 14 files / 151 tests, including partial replay failure, repeated loss,
  stale callbacks, mixed-version echo behavior, stable SOCKS fencing, and bounded jittered retry.
- Reconnect plus preload contract: 16 files / 167 tests after the exact replay-admission fix.
- Broader affected package: prior 32 files / 401 tests and latest-main 32 files / 347 tests;
  cross-version terminal wire passed 5/5.
- Full node/CLI/web typecheck, lint/audits, 87-gate manifest, max-lines, formatting, localization,
  relay/CLI/Electron/paired-web builds, and isolated paired-Electron startup/link routing pass on
  `origin/main@e570cade3c`; the final four-file fix rerun also passed full typecheck, lint/audits,
  changed-code quality, formatting, and diff checks.
- No mobile-facing persisted state, route, deep link, framing opcode, minimum version, or pairing
  durability contract changes. The optional JSON field is stripped by old peers and required only
  after exact echo on a reconnect attempt.

Published retired-frame isolation stage (#14694):

- Baseline/candidate oracle: 2 failed / 26 passed before the fix, 28/28 passed after it.
- Full affected browser-network/control gate: 16 files / 198 tests passed.
- Full Node/CLI/web typecheck, root lint, native audit, 87-gate manifest, max-lines, localization,
  formatting, diff checks, and changed-code quality pass. Full type-aware audit is clean for the
  changed stack and otherwise has the single upstream #14738 warning at
  `config/scripts/pr-test-loc-summary.test.mjs:88`.
- The full 31-patch stack rebased conflict-free onto `origin/main@3908978ba4`; `git range-diff`
  marked every patch identical before this ledger amend.

Published admission-fairness stage (#14747):

- Baseline: device A exhausted the old global host cap; device B, initial retry, and reconnect
  recovery failed. A naïve larger host share then starved ordinary waits.
- Candidate: focused 2 files / 16 tests and broader 15 files / 159 tests passed.
- Full Node/CLI/web typecheck, lint/audits, 87-gate manifest, max-lines, localization, formatting,
  diff checks, and changed-code quality pass.
- No live Electron claim is added; this stage changes admission and recovery contracts below the
  renderer and needs no rendered UI proof.
- The 32-patch stack rebased cleanly onto `origin/main@5b7f44278a`; range-diff marks every patch
  identical.

Do not promote narrow deterministic evidence into a live-topology claim. Record exact commands,
topology, versions, and explicit gaps at every later checkpoint.

## Public mutation ledger

- Pushed the STA-4150 staged branches listed in the draft-stack table.
- Opened and maintained their linked draft PRs; none were merged or marked ready.
- Attached draft PRs and posted one concise checkpoint per stage on STA-4150.
- Latest public checkpoint: attached/commented draft PR #14648; CI is running.
- Updated the Orca worktree comment/status at context, reproduction, fix, validation, and review
  checkpoints.
- Pushed the renderer-bridge branch, opened draft PR #14578 on #14566, attached it to STA-4150,
  and posted one concise checkpoint. The ticket remains In Progress.
- Rebased and pushed all 24 published branches onto `origin/main@e2d309e9cd`; the patch series was
  identical by `git range-diff`, and the rewritten #14578 CI run is in progress.
- Pushed the retained renderer registry and opened draft PR #14596 on #14578; attached it to
  STA-4150 and posted one concise checkpoint. The ticket remains In Progress.
- Pushed the environment-scoped composition and opened draft PR #14613 on #14596; attached it to
  STA-4150 and posted one concise checkpoint. The ticket remains In Progress.
- Pushed the reconciliation semantics and opened draft PR #14617 on #14613. It adds no wire field
  or production caller.
- Rebased all 25 branches onto `origin/main@9bb8836bb6`, confirmed all 26 patches identical before
  the ledger-only amend, and pushed them with lease checks.
- Rebased all 27 branches onto `origin/main@500b72d8ef` and force-pushed them with lease checks.
  Range-diff preserved the first 24 stages; the bridge date was already upstream, and the
  composition delta is the intentional lazy Electron IPC fix.
- Rebased all 28 stack branches onto `origin/main@a3b472d050`, confirmed all 29 patches identical
  by `git range-diff`, and force-pushed them with lease checks.
- Pushed the authenticated inventory stage, opened draft PR #14648 on #14617, attached it to
  STA-4150, and posted one concise checkpoint. The ticket remains In Progress.
- Locally rebased all 30 patches onto `origin/main@e570cade3c`; range-diff preserved every patch.
  Safety pointer `sta-4150-safety-pre-e570-rebase-20260814` retains the prior series. No branch,
  PR, or Linear mutation for this rebase or the reconnect stage had been published at that
  checkpoint.
- Atomically force-pushed all 28 previously published stack branches with exact remote-OID leases,
  pushed `sta-4150-browser-client-host-reconnect-grace`, and opened draft PR
  [#14691](https://github.com/stablyai/orca/pull/14691) on #14648. No PR was merged or marked ready.
- Attached #14691 to STA-4150 and posted one concise reconnect-stage checkpoint. The ticket remains
  In Progress.
- Rebased all 31 patches onto `origin/main@3908978ba4`, confirmed every patch identical by
  `git range-diff`, and atomically force-pushed all 29 prior public branches with exact remote-OID
  leases while creating the retired-frame branch with a must-not-exist lease.
- Opened draft PR [#14694](https://github.com/stablyai/orca/pull/14694) on #14691. No PR was merged
  or marked ready.
- GitHub attached #14694 to STA-4150 automatically; posted exactly one retired-frame checkpoint
  comment and kept the ticket In Progress.
- Locally rebased all 31 published patches plus the admission-fairness patch onto
  `origin/main@5b7f44278a`. No rewritten branch, new branch, PR, or Linear mutation has been
  published at this checkpoint.
- Atomically force-pushed all 30 existing public stack branches with exact remote-OID leases and
  created `sta-4150-browser-host-admission-fairness` with a must-not-exist lease. The first local
  refspec construction failed before any remote update; the corrected atomic transaction updated
  all 31 refs together.
- Opened draft PR [#14747](https://github.com/stablyai/orca/pull/14747) on #14694. Its initial
  inline shell argument expanded Markdown backticks; immediately replaced the description through
  literal stdin and verified the final title, body, base, head, and draft state.
- GitHub auto-attached #14747 to STA-4150. Posted exactly one admission-fairness checkpoint comment
  and kept the ticket In Progress.
- No PR was merged or marked ready.

## Completion rule

STA-4150 is complete only when the full acceptance matrix is proven on the activated,
capability-negotiated path while old clients and explicit server/offscreen placement still pass.
A green inert unit-test stack, a mounted local webview without remote routing, or a compatibility
fix to the old server-hosted path is not completion.
