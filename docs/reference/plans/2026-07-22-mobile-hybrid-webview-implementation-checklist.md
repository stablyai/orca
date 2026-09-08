# Mobile Hybrid WebView Completed-Work and Evidence Index

- **Scope:** Completed candidate implementation through 2026-08-23
- **Status:** Implementation record, not a production-readiness claim
- **Open work:** [remaining-work tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md)
- **Decisions:** [migration record](2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Ownership:** [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)
- **Operations:** [rollback runbook](../mobile-hybrid-webview-rollback.md)

> **2026-09-02 — the recent-user-gesture window described below was removed.** The
> shell no longer requires a recent native touch before a bridge capability runs: a
> scroll armed the window, so it gated nothing on a first-party page, and peer hybrid
> frameworks do not gate bridge calls this way. Gesture statements here describe the
> plan as written, not the shipped shell.

This index replaces the execution-era checklist. Completed rows mean the named
implementation and recorded candidate evidence exist. They do not close
physical-device, store, signed-release, production cloud Relay, cross-version,
performance, accessibility, or production-promotion gates.

## Provenance

| Record                                     | Value                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Initial migration                          | `9834f65552`                                                       |
| Audit plan                                 | `06f23ec818`                                                       |
| Candidate checkpoint                       | `e931b2db07`                                                       |
| `origin/main` and merge base at checkpoint | `4c984d4c1b`                                                       |
| Checkpoint comparison                      | 81 commits; 1,396 files; 140,153 additions; 8,772 deletions        |
| Post-audit integration checkpoint          | `b8d04428c0`                                                       |
| Lifecycle hardening checkpoint             | `5d4af00f5f`                                                       |
| Current `origin/main` checkpoint           | `0a613d5fed`                                                       |
| Post-audit comparison                      | 95 commits; 1,471 files; 141,224 additions; 9,112 deletions        |
| Latest verified package                    | `12df9ad54b240dd8ec9ef97b2e00c971536b0d05ca6c0c1834d47bbd509480ca` |
| Latest package size                        | 52 assets; 9,310,634 raw bytes; 2,691,771 gzip bytes               |

Commit and branch counts are historical evidence for that checkpoint; rerun
`git merge-base origin/main HEAD`, `git rev-list --count origin/main..HEAD`, and
`git diff --stat origin/main...HEAD` before using them in a release record.

## Completed Implementation

| Area                | Completed result                                                                                                                                                     | Durable evidence                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture        | Stable native shell plus Desktop-served RNW workspace package; native and Desktop authority split frozen                                                             | [Architecture](../mobile-hybrid-webview-architecture.md) and [migration record](2026-07-22-mobile-hybrid-webview-single-pr-migration.md) |
| UI source           | Duplicate web presentation removed; existing RN screens/components shared through native/web adapters                                                                | `a7dcd591b9`; [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)                                                   |
| Cutover             | Home, onboarding, notifications, cold resume, workspace, and exact-session entry use the production hosted route; native host editing remains native                 | `0a91c04a49`, `ce43d114be`, `7815f3afb3`, retired-name gates                                                                             |
| Build               | Deterministic RNW manifest/document/assets, CSP, size report, and independent verifier integrated with Desktop packaging                                             | `pnpm build:mobile-web-rnw`                                                                                                              |
| Delivery            | Authenticated `mobileWeb.package.*` methods work over paired Direct and local protocol-compatible Relay composition; gzip is capability-negotiated with raw fallback | Hosted WebView E2E commands below; package RPC/downloader/Relay gzip tests                                                               |
| Cache               | Exact manifest/activation parsing, bounded reads, path/symlink defense, concurrency, atomic host-scoped active/previous generations, corruption recovery             | `0a247f9743`, `9b9c76222f`, and cache/security test groups                                                                               |
| Private origin      | iOS custom scheme and Android fixed HTTPS origin enforce declared assets, CSP, navigation, download, popup, service-worker, and network isolation                    | iOS/Android security journeys below                                                                                                      |
| Bridge              | Exact v2 contract, named operations, generated grants/schemas/bounds, opaque authority, mutation reauthorization, response correlation, lifecycle cleanup            | `548d8d64aa`, `e526780848`, `b2068661f7`, `ee15298704`, `2094dde1f9`                                                                     |
| Routes              | Workspace, Accounts, Tasks, Session, Agent History, Files/Preview, Source Control, and Review use explicit hosted adapters                                           | [Parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)                                                                 |
| Terminal            | Real xterm/PTY byte path, bounded ACK/backpressure, links, selection/paste, reconnect/resnapshot, SSH recovery                                                       | Direct, SSH, and packaged SSH E2E commands                                                                                               |
| Native capabilities | Gesture/permission/foreground-mediated clipboard, documents/photos, haptics, external URLs, speech/audio, alerts, Android Back, settings, and diagnostics            | iOS/Android capability journeys and focused tests                                                                                        |
| Privacy             | Credentials, endpoints, paths, durable host identity, page payloads, and full build IDs excluded from page authority, storage, logs, cache identity, and diagnostics | `8ee4fcdac1`, `d6b8b14c82`, exact-app privacy audits                                                                                     |
| Security review     | 2026-08-21 independent OpenCode review covered bridge, shells, package store, runtime RPC, Relay, and SSH; high-severity findings fixed                              | Review record summarized below; not physical/store certification                                                                         |
| Rollback            | Automatic active/previous recovery, process-loss rollback, host-scoped manual recovery, and corrected Desktop/native incident procedure                              | [Rollback runbook](../mobile-hybrid-webview-rollback.md)                                                                                 |

## Reproducible Command Index

Run from the repository root unless noted.

| Purpose                                   | Command                                                           | Recorded scope                                                          |
| ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Build and independently verify package    | `pnpm build:mobile-web-rnw`                                       | Manifest, content hashes, assets, CSP, roles/MIME, limits, size report  |
| Typecheck hosted package                  | `pnpm typecheck:mobile-web`                                       | Hosted entry, adapters, schemas                                         |
| Lint hosted package                       | `pnpm lint:mobile-web`                                            | Hosted package and verifier                                             |
| Mobile unit/integration suite             | `pnpm --dir mobile test`                                          | Native/hosted adapters, bridge, cache, lifecycle, route fixtures        |
| Mobile typecheck                          | `pnpm --dir mobile typecheck`                                     | Expo/native and shared RN sources                                       |
| Mobile lint                               | `pnpm --dir mobile lint`                                          | Mobile production and test sources                                      |
| Direct actual-WKWebView journey           | `pnpm test:e2e:hosted-mobile-webview`                             | Package delivery, hosted UI, real bridge, Direct desktop                |
| Docker SSH actual-WKWebView journey       | `pnpm test:e2e:hosted-mobile-webview:ssh`                         | Execution-owner boundary, terminal mutation, native chat, reconnect     |
| Packaged macOS arm64 to Docker SSH        | `pnpm test:e2e:hosted-mobile-webview:ssh:packaged`                | Packaged resource lookup through actual WKWebView; no checkout fallback |
| iOS hosted journey                        | `pnpm --dir mobile test:e2e:hosted-webview`                       | Route/capability/reconnect simulator journey                            |
| iOS hostile-content journey               | `pnpm --dir mobile test:e2e:hosted-webview:security`              | Network/navigation/executable/storage isolation                         |
| Android route journey                     | `pnpm --dir mobile test:e2e:hosted-webview:android-routes`        | Hosted Source Control/Review and route interactions                     |
| Android real hardware Back                | `pnpm --dir mobile test:e2e:hosted-webview:android-back`          | Real `KEYCODE_BACK`: nested route, Session, workspace, native shell     |
| Android hostile-content journey           | `pnpm --dir mobile test:e2e:hosted-webview:android-security`      | Executable/network/navigation/privacy isolation                         |
| Android locally signed Release inspection | `pnpm --dir mobile test:e2e:hosted-webview:android-release`       | Local Release WebView behavior only; not Play signing                   |
| iOS process-loss rollback                 | `pnpm --dir mobile test:e2e:hosted-webview:ios-crash-loop`        | Repeated WebView loss and generation recovery on Simulator              |
| Android process-loss rollback             | `pnpm --dir mobile test:e2e:hosted-webview:android-crash-loop`    | Emulator crash-loop recovery                                            |
| Android cache corruption                  | `pnpm --dir mobile test:e2e:hosted-webview:android-corrupt-cache` | Corrupt active generation recovery                                      |
| Native iOS package-store tests            | `pnpm --dir mobile test:native:ios-web-store`                     | Swift verification/cache behavior                                       |

`SKIP_BUILD=1` may be used only when the exact package under test was built and
recorded immediately beforehand. Release evidence must record commit, Desktop
artifact, mobile artifact, package build ID, device/runtime, topology, command,
and raw result location.

## Package and Topology Evidence

- Latest independent verification:
  `12df9ad54b240dd8ec9ef97b2e00c971536b0d05ca6c0c1834d47bbd509480ca`,
  52 assets, 9,310,634 raw bytes, 2,691,771 gzip bytes.
- Packaged macOS arm64 Desktop through an isolated Docker SSH provider to an
  actual iOS WKWebView used
  `7c7c673deb74e158cdfb99b1ca536fd88cd3ab5dac4eb8db78c43ca12f6ce31d`.
  It verified package identity, terminal mutation, native-chat publication,
  disconnect retention, PTY/provider reattachment, and transcript recovery
  without a checkout fallback.
- Direct iOS Simulator journeys exercised real package RPC, private origin,
  bridge, route presentation, terminal input/output, attachments, native
  capabilities, reconnect, and cold restore.
- A deterministic protocol-compatible local Relay cell carried the production
  mobile Relay session, NaCl E2EE v2, Desktop `CloudRelayTransport`, package
  provider/downloader, hosted operations, and terminal/native-chat flows.
  This is composition evidence, not production cloud Relay validation.
- Classic SSH transcript authority and reconnect ran through the real Docker
  provider. WSL, folder-workspace breadth, multi-host races, and the supported
  topology matrix remain open.

## Route and Presentation Evidence

The [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md) is
the complete ownership and route record. Historical screenshot figures are not
current evidence: the prior production cutover redirected native `/h/**`
workspace routes into Hybrid, so that run could compare hosted output against
hosted output. `7815f3afb3` added a development-only native baseline and CDP
assertions before and after every native capture; `2094dde1f9` makes the
assertion fail closed when more targets exist than it can inspect. Corrected
native-versus-hosted results must replace the invalidated figures before parity
certification. Simulator evidence will still not close physical-device,
accessibility, input, or performance gates.

The 2026-08-23 strict iPhone Simulator Source Control/Review run used package
`12df9ad54b240dd8ec9ef97b2e00c971536b0d05ca6c0c1834d47bbd509480ca` and an
actual WKWebView. It covered host-list long press into Source Control, changed
file Review, return to Source Control and workspace root, physical workspace
selection into Session, and a second session-origin Source Control mount. The
corrected native-versus-hosted captures passed at 1.741% and 0.057% changed
pixels against a 3% budget, with 1.952 and 0.146 mean channel differences
against a 4.0 budget. The second mount retained branch and pull-request state.

## Security and Lifecycle Evidence

- TypeScript, Swift, and Kotlin share exact path, hash, MIME/role, manifest,
  activation, chunk, CSP, bridge-token, and size-limit corpora.
- Native stores reject oversized and non-exact JSON, duplicate decoded keys,
  malformed/lone surrogates, trailing input, excessive depth, coercions,
  traversal, symlinks, linked parents, unexpected file types, and out-of-root
  reads before activation. Mirrored concurrency tests cover same-host stage,
  activation, cleanup, commit/abort, and removal races.
- All 225 recorded production grants rejected eight malformed request shapes
  plus an oversized request before native/host access: 2,025 cases. Exported
  results and subscription events have invalid-payload admission coverage;
  invalid events retire their subscriptions.
- Cross-build/session tests cover a 15-pair stale authority grid. Cancellation,
  client replacement, disposal, replay, late subscription registration, and
  delayed mutation results fail closed.
- Concurrent branch comparisons retain independent bounded shell-owned host
  snapshots behind distinct single-use page continuations. Only an exact next
  page bypasses the initial rate charge; forged and replayed continuations
  remain throttled, and large comparisons no longer rerun Git for every
  128-entry page.
- Native alerts remain shell-owned while a refreshed package waits to replace
  its session, and concurrent replacement brokers cannot orphan or duplicate
  the alert. Rapid delayed Android Back traversals retain separate bounded
  expectations instead of redispatching handlers and over-popping routes.
- Exact iOS and Android emulator apps rendered hostile filenames, diffs,
  terminal links, provider/task strings, errors, Markdown, HTML, SVG, Mermaid,
  and image metadata inertly, with no execution marker or sentinel traffic.
- Exact-app audits inspected DOM/history, local and session storage, cookies,
  native logs, crash/exit records, network observations, and navigation. No
  credential, endpoint, path, host identity, or executable escape was accepted
  within the recorded emulator corpus.
- Automatic recovery covered corruption and repeated process loss. The iOS
  Simulator candidate-to-final three-crash drill restored the verified previous
  generation. Final physical/store-signed rollback drills remain open.
- Android API 36 exercised three real hardware Back events from Agent History
  through Session and workspace root to the reset app's native shell, followed
  by a clean bridge-log audit. Dirty-state, mixed-version, and physical-device
  Back coverage remain open.
- The 2026-08-21 independent OpenCode review found issues in live bridge/native/
  package/runtime RPC/Relay/SSH boundaries. High-severity findings were repaired,
  including bounded SSH/Relay methods, connection-owned file-watch teardown,
  and credential-query redaction. Exact store-signed corpus and broader live
  race/allocation review remain open.

## Evidence Interpretation

The latest recorded full mobile validation passed 722 files and 4,715 tests,
with three skips. The latest concurrent root run passed 6,193 files and 58,084
tests, with 39 skipped files and 245 skipped tests; two deadline-sensitive tests
failed under load and then passed 25/25 together with one worker. Root, mobile,
and hosted-web typechecks and lints, changed-code quality, 90 reliability gates,
localization, max-lines, and Electron ratchets also passed. Relay Markdown
discovery passed its shared cross-platform process-launcher boundary tests.
Rerun current CI before release; historical counts are not evergreen.

The 2026-08-23 concurrency hardening additionally passed 43 focused pager,
broker, alert, package-session, and Back-navigation tests; mobile and hosted-web
typechecks; focused lint and formatting; diff hygiene; and the strict
actual-WKWebView Source Control/Review journey above.

No entry in this document claims the following passed: physical phones or
tablets, production-store-signed apps, Windows/Linux/headless packaged Desktop,
production cloud Relay, the real mixed-version matrix, final accessibility and
input review, physical-device performance or endurance, final release rollback,
or App Review. Those items live only in the
[open-gate tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md).
