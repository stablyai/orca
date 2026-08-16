# STA-4150 Client-Hosted Browser Progress

Last updated: 2026-08-14

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
- Latest reviewed stack tip: commit `fe6b420d0c` on
  `sta-4150-browser-electron-page-commands`, draft PR
  [#14566](https://github.com/stablyai/orca/pull/14566).
- PR #14566: final lifecycle/correctness/security review clean; all 43 required CI checks pass.
- Current development branch: `sta-4150-browser-client-page-mount-bridge`, draft PR
  [#14578](https://github.com/stablyai/orca/pull/14578), stacked on #14566.
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

| PR                                                    | Stage            | What it establishes                                                       |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| [#14440](https://github.com/stablyai/orca/pull/14440) | Contracts        | Optional host/tunnel contracts without advertisement                      |
| [#14470](https://github.com/stablyai/orca/pull/14470) | Paired tunnel    | Dedicated paired browser tunnel                                           |
| [#14484](https://github.com/stablyai/orca/pull/14484) | Host lease       | Exact lease authority and generations                                     |
| [#14493](https://github.com/stablyai/orca/pull/14493) | Admission        | Bounded browser-host admission                                            |
| [#14495](https://github.com/stablyai/orca/pull/14495) | Route budgets    | Bounded tunnel resources                                                  |
| [#14504](https://github.com/stablyai/orca/pull/14504) | Memory           | Host/process tunnel memory accounting                                     |
| [#14507](https://github.com/stablyai/orca/pull/14507) | Reconnect        | Fenced tunnel generation replacement                                      |
| [#14513](https://github.com/stablyai/orca/pull/14513) | Execution host   | Exact native/SSH execution-host routes                                    |
| [#14516](https://github.com/stablyai/orca/pull/14516) | Partitions       | Route/profile-scoped Electron sessions                                    |
| [#14517](https://github.com/stablyai/orca/pull/14517) | Guest quarantine | Blank, popup-denied WebContents admission                                 |
| [#14518](https://github.com/stablyai/orca/pull/14518) | Release barrier  | Route policy held through destruction                                     |
| [#14519](https://github.com/stablyai/orca/pull/14519) | Crash fencing    | Guest/renderer process-loss retirement                                    |
| [#14520](https://github.com/stablyai/orca/pull/14520) | Renderer owner   | Prepared pages fenced to one renderer                                     |
| [#14529](https://github.com/stablyai/orca/pull/14529) | Placement        | Runtime-owned client page placement                                       |
| [#14531](https://github.com/stablyai/orca/pull/14531) | Host selection   | Capability-qualified client placement                                     |
| [#14536](https://github.com/stablyai/orca/pull/14536) | Replacement      | Exact retirement before placement replacement                             |
| [#14539](https://github.com/stablyai/orca/pull/14539) | Retirement       | Two-phase page-retirement settlement                                      |
| [#14544](https://github.com/stablyai/orca/pull/14544) | Page commands    | Optional, negotiated create/navigate contracts                            |
| [#14550](https://github.com/stablyai/orca/pull/14550) | Dispatch         | Bounded FIFO/dedupe/replay command handling                               |
| [#14553](https://github.com/stablyai/orca/pull/14553) | Results          | Exact authenticated result admission                                      |
| [#14557](https://github.com/stablyai/orca/pull/14557) | Transport        | Same-socket command/result settlement                                     |
| [#14558](https://github.com/stablyai/orca/pull/14558) | Lifecycle        | Lease plus command-dispatch composition                                   |
| [#14566](https://github.com/stablyai/orca/pull/14566) | Electron main    | Route, partition, blank mount, exact guest claim, navigation, and cleanup |

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

Before publishing this stage:

- [x] Run the final full typecheck, native/type-aware audits, max-lines ratchet, formatting, and
      diff checks against the completed stage diff.
- [x] Perform fresh correctness, lifecycle, security, and resource review.
- [x] Commit the renderer-bridge stage.
- [x] Sync the draft stack onto the latest `origin/main` while preserving every PR base.
- [x] Push and open a draft PR stacked on #14566.
- [ ] Monitor required CI and fix any actionable failure.
- [x] Attach the PR and post one concise Linear checkpoint while keeping STA-4150 In Progress.
- [ ] Update the Orca worktree comment with the published checkpoint.

## Acceptance matrix

| Requirement                                                        | State                     | Evidence or blocker                                                                                               |
| ------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Negotiated client-host and tunnel contracts                        | Partial                   | Schemas/RPC methods exist; runtime capabilities are intentionally not advertised                                  |
| Runtime placement, leases, authority epochs, host/page generations | Partial                   | Deterministic registries exist; normal browser creation does not call them                                        |
| Main browser-host registry                                         | Partial                   | Route Session, guest, command executor, and exact renderer bridge exist; no production lease/executor composition |
| Renderer-owned retained webview registry and surface               | Missing                   | Existing local registry is not authority/page scoped and no client-host IPC consumer exists                       |
| Route/profile-scoped partition before first request                | Partial                   | Deterministic policy ordering passes; real Electron worker/popup/speculation proof is missing                     |
| SOCKS5 tunnel with remote DNS and bounded flow control             | Partial                   | Native and SSH route foundations exist; WSL and production route retention are incomplete                         |
| Agent/CLI routing by placement                                     | Missing                   | Only create/navigate command foundations exist; public browser methods still use current server behavior          |
| Inventory/reconciliation after ambiguous outcomes and restart      | Missing                   | Failed/ambiguous creates intentionally consume bounded capacity until authenticated reconciliation exists         |
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

1. Finish and publish the exact renderer bridge stage.
2. Add the renderer authority/page-keyed registry and preload consumer. Mount blank in a stable
   retained viewport; never use webview reparenting as display behavior.
3. Compose one environment-scoped `PairedRuntimeBrowserClientHost` with the command executor,
   exact route resolver, current renderer bridge, shutdown, and page retirement.
4. Add inventory/reclaim/restore/close reconciliation before recovering ambiguous slots or routes.
5. Add optional placement to logical session-tab publication and renderer state. Follow
   `docs/reference/remote-wire-compatibility.md`; old callers and clients remain server-hosted.
6. Route create and every existing browser command by explicit placement. Never silently fall
   back or migrate a live page.
7. Add local browser chrome and interaction-owner fencing for client placement.
8. Add mobile mirroring and dedicated large-result channels without coupling them to control or
   terminal multiplexing.
9. Run real Electron containment and traffic proof, then headed/headless/browserless paired
   journeys and the physical platform/provider matrix.
10. Enable client placement only behind a kill switch for newly created eligible desktop pages;
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

Do not promote narrow deterministic evidence into a live-topology claim. Record exact commands,
topology, versions, and explicit gaps at every later checkpoint.

## Public mutation ledger

- Pushed the STA-4150 staged branches listed in the draft-stack table.
- Opened and maintained their linked draft PRs; none were merged or marked ready.
- Attached draft PRs and posted one concise checkpoint per stage on STA-4150.
- Latest public checkpoint: attached/commented PR #14566 after all required CI passed.
- Updated the Orca worktree comment/status at context, reproduction, fix, validation, and review
  checkpoints.
- Pushed the renderer-bridge branch, opened draft PR #14578 on #14566, attached it to STA-4150,
  and posted one concise checkpoint. The ticket remains In Progress.

## Completion rule

STA-4150 is complete only when the full acceptance matrix is proven on the activated,
capability-negotiated path while old clients and explicit server/offscreen placement still pass.
A green inert unit-test stack, a mounted local webview without remote routing, or a compatibility
fix to the old server-hosted path is not completion.
