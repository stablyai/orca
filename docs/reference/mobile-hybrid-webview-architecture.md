# Mobile Hybrid WebView Architecture

- **Status:** Implemented as the sole workspace route in the dedicated release
  candidate; production promotion is not approved
- **Last updated:** September 2, 2026
- **Migration design:**
  [`plans/2026-07-22-mobile-hybrid-webview-single-pr-migration.md`](./plans/2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Active remaining work:**
  [`plans/2026-07-27-mobile-hybrid-webview-remaining-work.md`](./plans/2026-07-27-mobile-hybrid-webview-remaining-work.md)
- **Rollback runbook:**
  [`mobile-hybrid-webview-rollback.md`](./mobile-hybrid-webview-rollback.md)

## Summary

Orca Mobile remains a React Native/Expo application. The stable native shell
owns device trust, encrypted connectivity, package verification, WebView
isolation, and privileged device capabilities. Each paired Orca Desktop ships a
React Native Web package built from the existing mobile workspace screens. The
shell downloads that package through the authenticated mobile RPC connection
and renders it from a private native asset origin.

This is not a replacement web UI. The hosted workspace application imports the
same React Native screens and presentation components used by the native
routes. Platform adapters change how those screens reach Desktop and native
capabilities; they do not create a second visual system.

The architecture removes the broad workspace UI/RPC version boundary:

- A Desktop release and its mobile workspace UI are built and shipped together.
- Different paired Desktops may serve different UI versions.
- Most workspace feature changes no longer wait for a mobile store release.
- Native capability, secure transport, cache, origin, and bridge changes still
  require a new iOS or Android shell.

## Current Rollout State

The hybrid architecture is merged into the shared source tree but is selected
at mobile build time. Ordinary release builds default to the existing native
workspace routes. A dedicated candidate opts into `/hybrid` with
`EXPO_PUBLIC_ORCA_MOBILE_ARCHITECTURE=hybrid`; it has no user-selectable
fallback. Restored legacy `/h/...` shell routes redirect to `/hybrid` only in
that hybrid build.

The screen modules under `mobile/app/h/` remain because the hosted React Native
Web package imports that shared source. They are no longer native-shell
workspace destinations.

Use separate Desktop RC channels and TestFlight/internal mobile releases to
validate the hybrid candidate while daily native mobile builds remain
unchanged. A current Desktop can serve both native and hybrid mobile builds;
pre-feature Desktops cannot serve the hybrid package. Promote the exact
reviewed candidate only after the security,
physical-device, sustained-performance, rollback, and App Store gates in the
active tracker pass. TestFlight evidence does not establish App Store
acceptance.

## Ownership Boundaries

| Owner                                       | Responsibilities                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native mobile shell                         | Pairing and host selection; secure credential storage; authenticated encrypted transport; QR scanning; notifications and deep links; package verification, cache, private origin, and recovery; clipboard, haptics, audio, camera and file/photo pickers; native onboarding, pairing recovery, and privacy; diagnostics capture (transport log, reachability probes, report submission) |
| Desktop-served React Native Web application | Workspace list and creation; sessions and terminal presentation; files, previews, diffs, source control, reviews, tasks, accounts, browser presentation, Agent History, native-chat presentation, and the settings, troubleshooting and connection-log screens                                                                                                                          |
| Desktop runtime                             | Builds and ships the matching web package; serves its manifest and chunks through authenticated RPC; reauthorizes every workspace mutation; enforces host, workspace, provider, path, and resource limits                                                                                                                                                                               |
| Typed native bridge                         | Connects the unprivileged page to explicitly granted Desktop operations and native capabilities; carries connection and route state without exposing transport credentials                                                                                                                                                                                                              |

The page never receives the raw RPC client, pairing credential, host endpoint,
private key, cache path, or unrestricted native module access. Native-owned
routes remain outside the hosted route graph.

## Build and Delivery Flow

1. `pnpm --dir mobile export:host-web` runs
   `mobile/scripts/export-host-mobile-web.mjs`, which exports the
   `mobile/host-web-app/` route root for the web platform.
2. The hosted route graph imports the existing screens under `mobile/app/` and
   their components under `mobile/src/`.
3. `config/scripts/package-mobile-web-rnw.mjs` removes runtime code generation,
   creates content-addressed assets, emits a strict CSP, and writes a canonical
   manifest containing hashes, sizes, MIME roles, build identity, and the
   supported bridge range.
4. `config/scripts/verify-mobile-web-rnw-build.mjs` verifies the manifest,
   assets, CSP, source boundaries, and size budgets. Desktop packaging copies
   the exact output to `Resources/mobile-web`. Steps 1, 3, and 4 run together
   as `pnpm build:mobile-web-rnw`, which `pnpm build:mobile-web` aliases and
   the Desktop release builds invoke.
5. A paired shell requests `mobileWeb.package.manifest` and bounded
   `mobileWeb.package.asset` chunks over the existing authenticated,
   end-to-end-encrypted mobile RPC connection.
6. The shell reassembles each asset in memory, checks it against the manifest
   hash, and hands it to the native store whole with `writeStagedAsset`. One
   `commitGeneration` call then re-verifies every manifest asset on disk, writes
   the manifest, and renames the staged tree into place. Activation is that one
   rename; incomplete or corrupt generations never become active.
7. The shell renders only verified assets through a native-controlled origin:
   `orca-mobile-web://<session>/` on iOS and
   `https://orca-mobile-web.invalid/` on Android.
8. The page and shell exchange strict version, shell-session, build, request,
   subscription, and sequence envelopes through the capability bridge.

Development resolves the package from `out/mobile-web-rnw`. Packaged Desktop
builds resolve it from the application resources directory. Tests may set
`ORCA_MOBILE_WEB_PACKAGE_ROOT` to an explicit verified fixture; production
support procedures must not replace packaged assets manually.

## UI Preservation

`mobile/host-web-app/index.tsx` mounts the same `HostScreen` used by the native
host route. The hosted route adapters then reuse the existing Session, Tasks,
Files, Preview, Source Control, Review, Accounts, Agent History, browser, and
native-chat presentation.

When changing a workspace feature:

- Change the existing mobile screen or component once.
- Preserve its React Native public props and behavior.
- Put runtime-specific transport, storage, nested-WebView, or capability work
  behind a concrete `.native`/`.web` module or named operation adapter.
- Do not copy JSX into a DOM-only or desktop-renderer implementation.
- Validate both native and hosted routes. Screenshot equality alone does not
  replace interaction, keyboard, accessibility, and lifecycle checks.

The source boundary and package verifier reject the retired duplicate
presentation and direct hosted access to native clipboard, picker, haptic, and
external-link authority.

The native shell owns the top safe-area inset. It pads the container that holds
the WebView, so inside the hosted document the top edge is no longer a device
edge. Android derives `env(safe-area-inset-top)` from the window's display
cutout and does not subtract the WebView's offset, so the hosted route root
pins its own top inset to zero (`HostedPageTopInsetProvider`). The remaining
edges still meet the device and keep their measured values.

## Security Model

### Transport and package trust

- Package delivery uses the already paired authenticated encrypted channel, not
  unauthenticated HTTP.
- Pairing credentials and privileged host identity never belong in a hosted
  document URL.
- Desktop verifies the package before serving it. The native store independently
  checks the canonical manifest, build identity, asset path, byte length,
  content hash, MIME role, bridge range, and bounded chunk sequence.
- The build id is the sha256 of the canonical manifest bytes, so the generation
  directory name authenticates the manifest and the manifest authenticates every
  asset. The store re-derives that hash on every open.
- Cache reads, writes, cleanup, and commit reject traversal, linked trees,
  non-regular files, and paths outside the native cache root.
- Caches are scoped to one paired host, which keeps exactly one generation.

### WebView isolation

- The document loads only from the native-controlled private origin.
- File/content access, DOM storage, database storage, mixed content, downloads,
  arbitrary windows, and direct network loads are disabled.
- CSP uses `default-src 'none'`, `connect-src 'none'`, and explicit
  content-addressed script, style, image, font, and frame rules.
- No served document carries an inline script. The page document, the markdown
  editor document, and the mermaid frame document each load a content-addressed
  `assets/<sha256>.js`, so the native policy pins no script hash and the page's
  scripts change over the air. No served document carries a policy of its own
  either; the native response header is the enforced one.
  `verify-mobile-web-rnw-build.mjs` fails the build on an inline script body or a
  `Content-Security-Policy` meta in any packaged document. The in-app WebView
  documents that the native app renders without a server still inline their
  script under a meta hash; those hashes ship with the app bundle and no native
  binary pins them.
- The two embedded frame documents are sandboxed, so their origin is opaque.
  WebKit resolves `'self'` against that opaque origin and matches nothing, while
  Chromium resolves it against the response URL and matches. The native frame
  policy therefore names the per-session package origin outright rather than
  using `'self'`.
- iOS installs content rules and a document-start network API blocker. Android
  now installs the matching document-start script, denying `fetch`,
  `XMLHttpRequest`, `WebSocket`, and `serviceWorker` on the private origin, and
  also blocks network loads and intercepts exact private-origin asset
  requests.
- Top-level navigation is restricted to the active document. External
  navigation, popups, downloads, workers, and arbitrary bridge origins fail
  closed.
- The Android private origin's host label is a hash of the session id, never a
  slice of it. Session ids are base64url — the bridge contract pins that shape —
  and no URL host can carry one: `https` is a special scheme, so Chromium
  ASCII-lowercases the host of every URL it loads and reports back, and
  `java.net.URI.getHost()` is null for a label holding `_`. A sliced label lost
  every asset request to a 403 and dropped every bridge message
  (`MobileWebOrigin.kt`). Deriving the label instead keeps the wire token
  unchanged, which matters because the page bundle is served by the desktop and
  validates the session id with its own copy of the contract. iOS uses a custom
  scheme, whose opaque host preserves case and `_`, which is why the iOS lane
  never saw it.
- A failed main-frame document does not stop at Chromium's error page: the
  Android shell hides the WebView and reports `onLoadState` `failed` with a
  reason code the React Native shell shows instead.

### Capability bridge

- The first production protocol is exact version 2.
- Every message is schema checked and bound to the active shell session and
  package build.
- On Android, the private origin host derived from the native `activeSessionId`
  is the authority for accepting a bridge message; the URL fragment check is a
  secondary assertion (`MobileWebBridgeDocumentUrl.kt`, and
  `mobile/src/mobile-web/mobile-web-history-session-fragment.ts`, which keeps
  page history writes on that fragment).
- The shell grants named operation/capability pairs with request, response,
  concurrency, subscription, rate, and message limits. What is left of the
  workspace translator is the `worktree.ps` catalog read that mints the page's
  opaque workspace handles, and the two creation writes, which register a handle
  for a workspace no catalog page has listed yet. Every workspace-creation read
  and provider lookup is the same desktop request the native app makes, issued
  from the page through `mobileWebHostRpcSender`, an `RpcClient.sendRequest` over
  `workspace.hostRequest`.
- The page calls `workspace.hostRequest` for a unary desktop method and
  `workspace.hostSubscribe` for a stream. The shell consults no method table of
  its own: it resolves the opaque workspace handle, and forwards bounded domain
  JSON without a shell-owned response schema. The Desktop socket gate
  (`isMobileWebHostRpcMethod`) is the only allowlist, and it rejects any other
  method on a mobile-scope socket. Hybrid requires package support and
  `mobileWeb.hybrid.v1`; older Desktop builds show Update Desktop. Completed
  generic slices have no fallback to superseded shell domain operations.
- The shell rewrites the page's workspace handle into `worktree: id:<host>` when
  the payload carries a `workspaceId`, and forwards the params untouched when it
  does not. Which shell operation the page called decides unary versus stream,
  and a stream's desktop cancel name is derived from its subscribe name:
  `X.watch` becomes `X.unwatch` and `X.subscribe` becomes `X.unsubscribe`. A
  method matching neither rule cannot be subscribed to. The desktop registers
  `mobileWeb.files.unwatch` and `mobileWeb.nativeChat.unsubscribe` as aliases of
  the handlers the released native app still calls under their original names.
- One envelope bounds both directions: a request, a response and a stream event
  each have to fit `MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES`, along with the depth
  and node-count limits. Per-operation grants on `workspace.hostRequest` still
  supply the in-flight ceiling, and cancelling a page request does not release
  its host-work slot until the host call settles. The Desktop is trusted, so the
  page addresses host tabs, browser pages and provider sessions by their host
  ids. Generic subscriptions, native-chat domain actions, file reads, Source
  Control (status, diff, history, branches, compares, review metadata and the
  Git writes), session snapshot/feed/actions and terminal metadata use this
  path. A Source Control result the Desktop cannot bound in its own shape is
  projected and clipped by a `mobileWeb.sourceControl.*` wrapper before it
  crosses the bridge; the writes the page reaches are the Git methods
  themselves. Only commit-message generation still runs as a shell operation,
  because it outlives the host lane's fifteen-second request deadline and the
  page cancels it while it runs.
  Control reads/watch, session snapshot/feed/actions, terminal metadata and the
  whole provider review surface use this path.
- Provider review is desktop-owned end to end. `mobileWeb.review.*` reads the
  branch's hosted review, projects the provider work item into the page contract,
  and runs every comment, management, submission and creation action. GitHub and
  GitLab differ only inside those handlers; the shell knows neither. Review
  output the provider does not bound — check-run job logs and file diffs — is
  clipped on the desktop so the page's schema bounds hold.
  Control reads/watch, session snapshot/feed/actions, terminal metadata and
  browser input/navigation/screencast use this path.
- Browser control is desktop-owned end to end. `mobileWeb.browser.navigate`,
  `.history`, `.pointer`, `.keyboard`, `.dialog` and the `.subscribe`/
  `.unsubscribe` screencast stream are the page's whole surface. The wrapper is
  where the worktree is scoped, the tab URL is stripped
  (`browser-url-privacy.ts`), the title and dialog text are bounded, the
  press/release fallback for a failed plain click runs, and pointer and keyboard
  traffic meet a per-connection token bucket
  (`mobile-web-browser-input-rate-limit.ts`). The generic lane carries JSON only,
  so a binary screencast frame crosses it as a run of base64 `frameChunk`
  events the page reassembles. The stream opens with a bare `ready` carrying the
  cancel id; the browser's own `ready` is the one that carries tab state. The
  released native app keeps calling the raw `browser.*` methods and
  `browser.screencast` unchanged.
  page addresses host tabs, browser pages, provider sessions, repositories and
  work items by their host ids. Generic subscriptions, native-chat domain
  actions, file reads, Source Control reads/watch, session snapshot/feed/actions,
  terminal metadata and every Hosted Tasks read and write use this path.
- Hosted Tasks runs the operation modules the native app runs
  (`mobile/src/tasks/native-host-task-*.ts`) over a page-side sender that
  forwards `sendRequest` as `workspace.hostRequest`
  (`web-host-task-rpc-sender.ts`). Those methods are already on the released
  native app's socket allowlist, so the socket gate admits them with no
  `mobileWeb.*` wrapper. The one exception is the GitHub project table: a view
  holds up to 500 items and can exceed the envelope, so
  `mobileWeb.tasks.projectTable` returns one row window plus a `nextRowOffset`
  and the page reassembles the table.
  page addresses host tabs, browser pages, provider sessions and repositories by
  their host ids, and a page-side host request may name its own deadline up to
  `MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS` when the desktop call is slower than
  the shell default; only the workspace handle stays opaque, because a worktree id
  carries the host path. Generic subscriptions, native-chat domain actions, file
  reads, Source Control reads/watch, session snapshot/feed/actions, terminal
  metadata, workspace activation/pin/sleep/removal, the repository catalog, the
  workspace view settings and the whole account domain use this path.
  ids. Generic subscriptions, native-chat domain actions, file reads/open/write,
  Source Control reads/watch, session snapshot/feed/actions, terminal metadata,
  terminal artifact previews, markdown tab reads/saves and agent history
  reads/resume use this path. None of it keeps a handle ledger on either side:
  a terminal artifact is addressed by the tab plus the terminal text that named
  it, and the Desktop re-resolves the path and re-earns the file grant on every
  chunk; an agent session is addressed by the agent and provider session id the
  scan reports, and paging is a caller-supplied offset. The shell keeps only
  markdown drafts, because those are device storage, not host state.
- Decisions behind the generic lane and its 2026-09-07 simplification are in
  [`plans/2026-09-07-long-lived-mobile-shell-decisions.md`](./plans/2026-09-07-long-lived-mobile-shell-decisions.md).
  Unmigrated domain operations keep their current adapters until moved.
- Hybrid has no released users; intermediate PR shells/pages are unsupported.
  Released native mobile RPC compatibility and SSH runtime negotiation remain.
  The first released hybrid shell/page contract must evolve compatibly.
- Clipboard reads, pickers, external links, haptics, dictation, and related
  native actions require the relevant grant; privacy-sensitive actions also
  require the system permission the platform asks for. The shell's own
  recent-user-gesture window was removed on 2026-09-02: a scroll armed it, so it
  gated nothing on a first-party page, and peer hybrid frameworks do not gate
  bridge calls on gestures.
- Host switch, reconnect, process loss, cancellation, and package replacement
  invalidate stale authority.

Independent adversarial review, generated fuzzing, privacy/log auditing, and
cross-scope race testing remain release gates. Do not treat this document as
evidence that those gates have passed.

## Compatibility Policy

Bridge version 2 is the first production policy, and
`MOBILE_WEB_BRIDGE_PROTOCOL_VERSION` in `src/shared/mobile-web/bridge-limits.ts`
is the only compat gate the bridge has. Additive operations stay on the same
version and negotiate through `init.grants`. A breaking envelope or security
semantic requires a new native bridge version.

The page parses every shell-authored payload with the plain contract schema, in
both directions and at every level. There is no forgiving rewrite: an
undeclared key, an unclassifiable array member, or an unknown value for a closed
set fails the frame with `invalid_message` and `retryable: false`. The protocol
version is what gates a change, so a field the page cannot name is a bug in the
shell/page/desktop release set rather than skew to absorb. The desktop reshapes
transcripts to the page contract before they leave the host; see
`mobile-web-native-chat-read-budget.ts`.

What a change costs depends on its direction and on whether it adds a field or
an operation:

- **Additive field, shell to page** (any result or event payload) needs the
  page contract to declare it in the same release. An undeclared key fails the
  frame.
- **Additive field, page to shell** in a native or legacy payload is a break.
  Native-capability and legacy request schemas stay `.strict()`; a newer page
  that sends a field an older shell does not know gets `invalid_request`. There
  is no shell feature list to gate it with, so such a field needs a new
  operation or a shell release. The generic host request has a strict routing
  envelope but opaque bounded domain params, so desktop/page field additions on
  that lane do not need an APK schema change.
- **Additive operation, either direction** negotiates through `init.grants`.
  The page fails an ungranted operation immediately with
  `unsupported_capability`, so a newer page against an older shell degrades at
  the call site instead of hanging.
- **Additive frame type, either direction** is safe at the same version: both
  receivers drop a frame they cannot parse.
- **Additive envelope field, shell to page** must be declared before it is
  sent. `parseMobileWebBridgeShellMessage` and
  `parseMobileWebBridgeInitialMessage` drop a frame carrying a key the page does
  not declare, which for `init` costs the page every grant at once. Failing
  closed also keeps the leak fence: an undeclared `resumeRoute.hostPath` or a
  raw error `message` never reaches the page.
- **Additive route kind or other closed variant** must negotiate. An unknown
  `resumeRoute.kind` fails `init`, because the page cannot invent a meaning for
  a variant it does not have.

Desktop must retain support for the existing bridge floor until a replacement
has shipped in at least two stable mobile releases and the supported shell
minimum has advanced. A Desktop package must declare the exact range it was
built and tested against; the native store rejects an incompatible package
before opening it.

This bridge policy is separate from the older broad mobile/Desktop protocol
version constants used by native routes.

## Cache and Recovery

Each paired host keeps exactly one committed generation. The shell opens that
generation first, then refreshes from Desktop when connected; a cached package
stays usable while a refresh fails or Desktop is offline. The cache holds at
most four hosts and evicts the least recently activated one on overflow.

Staged writes live under `<cache>/<hostKey>/tmp/<buildId>/` and are never
activation candidates. A disk-full write throws and the shell drops the staged
tree with `abortGeneration`; launching the app removes every `tmp` directory, so
an interrupted download can never survive a restart.

A WebView process restart retains the shell session id but retires and rebuilds
the capability broker, so every page-scoped subscription, stream, and pending
request from the lost process is discarded rather than reused.

There is no A/B rollback: a generation that cannot render is not a generation to
fall back from. When the page fails to load, the shell deletes that host's cache
and downloads the package again, once per host selection. If Desktop is
unreachable, the shell stays in its offline state and retries when the
connection returns. Never edit cached assets by hand. See the
[rollback and recovery runbook](./mobile-hybrid-webview-rollback.md) for
incident containment and store-release recovery.

## Developer Workflow

From the repository root:

```bash
pnpm install
pnpm build:mobile-web-rnw
pnpm dev
```

From `mobile/`, start Metro or a paired iOS Simulator development session:

```bash
pnpm start
pnpm start:emulator -- --device "iPhone 17 Pro" --wait-for-ready
```

The emulator launcher owns its temporary runtime and user-data directory. Do
not repeat `ORCA_DEV_USER_DATA_PATH` or `ORCA_USER_DATA_PATH` prefixes manually.
Use the Orca emulator commands against the registered device:

```bash
orca emulator list --json
orca emulator attach "iPhone 17 Pro" --json
orca emulator ax --json
orca emulator tap 0.5 0.7 --json
```

After changing shared UI, a Metro reload is usually enough for the native
route. Rebuild `out/mobile-web-rnw` before testing package identity or Desktop
delivery. Native shell module changes require a new development-client build.

Useful focused checks from the repository root:

```bash
pnpm typecheck:mobile-web
pnpm lint:mobile-web
pnpm build:mobile-web-rnw
pnpm test:e2e:hosted-mobile-webview
pnpm test:e2e:hosted-mobile-webview:ssh
pnpm test:e2e:hosted-mobile-webview:ssh:packaged
```

The iOS hosted-WebView and packaged SSH journeys require macOS, Xcode, an
available simulator, and Docker for the SSH topology. The nine
`test:e2e:hosted-webview*` entrypoints under `mobile/`, and what each one needs,
are tabulated in `mobile/README.md`. The native store suites live beside them:
`pnpm --dir mobile test:native:ios-web-store` for Swift and
`:orca-expo-mobile-web-shell:testDebugUnitTest` for Kotlin, both run by
`.github/workflows/mobile-native-shell-tests.yml`. Physical-device and
store-signed evidence must be recorded separately from emulator results.

## Support and Privacy

Ask users to start with **Settings → Troubleshooting → Run diagnostics**, then
open **Connection Log** for the selected host and choose **Copy diagnostics**.
The hosted snapshot includes the mobile shell/platform, connection state,
bridge version, a 12-character build prefix, package source and state,
activation/refresh timing, health, recovery count, bounded terminal flow
metrics, and a stable failure code.

Do not request or attach:

- Pairing tokens, private keys, QR payloads, or raw credentials.
- Host endpoints, full build IDs, shell session IDs, or absolute cache paths.
- Repository content, filenames, diffs, terminal bytes, chat/page payloads, or
  cached package contents.

Treat credential exposure, cross-host cache use, executable hash mismatch,
private-origin escape, or an unauthorized capability call as a security
incident. For routine failures, record the action attempted and whether the
result persists after reconnect, restart, or switching hosts.

## Troubleshooting

| Symptom                                                                   | Check                                                                          | Recovery                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| No paired Desktop                                                         | Confirm Desktop is running and pairing completed                               | Scan a new QR code; never copy the encoded credential into a ticket        |
| Desktop unreachable                                                       | Check LAN/Tailscale state, firewall port 6768, sleep state, and Connection Log | Reconnect, wake Desktop, or switch hosts                                   |
| “Connect to … to finish setting up.”                                      | No compatible verified generation exists for that host                         | Connect to the paired Desktop and choose **Retry**                         |
| Refresh warning while UI still works                                      | Healthy cached generation is active but the new package failed                 | Keep using the cache; correct Desktop delivery, then **Retry**             |
| Interface fails after one Desktop update                                  | Regression follows the Desktop package                                         | Stop that Desktop rollout and use the rollback runbook                     |
| Repeated WebView termination                                              | Health/crash-loop recovery should select a compatible previous generation      | Choose **Use last version** if offered; otherwise switch hosts             |
| Corrupt or unreadable host cache                                          | Package fails native verification or open                                      | Choose **Reset**, then redownload from the authenticated Desktop           |
| Incompatible bridge                                                       | Desktop package does not support the installed shell                           | Restore a compatible Desktop package or install the required store release |
| Pairing, origin, bridge, picker, audio, notification, or recovery failure | Native-owned boundary is affected                                              | Halt the native rollout and ship a corrected store build                   |

For terminal rendering failures, use the transport repro scripts documented in
[`mobile/README.md`](../../mobile/README.md) to separate Desktop stream
production from mobile presentation.

## App Review Preparation

App Review must be able to exercise the real production-shaped companion
without access to an employee LAN:

- Maintain an internet-accessible review Desktop for the entire review window,
  with durable credentials, representative workspaces/sessions/tasks, and a
  sample pairing QR plus exact setup steps.
- Explain accurately that Desktop supplies its matching workspace interface
  through Orca's authenticated encrypted connection. Do not describe the app as
  a generic browser or conceal remotely delivered workspace functionality.
- Identify the meaningful native functionality available to the reviewer:
  pairing and host recovery, secure connectivity, notifications and deep links,
  camera/file/photo workflows, clipboard and haptics, microphone/two-way audio,
  settings, diagnostics, and native capability mediation.
- Provide a short review path covering pairing, workspace/session navigation,
  terminal interaction, one native capability, disconnection/recovery, and
  diagnostics.
- Record every reviewer question and requested change. Resubmit the final exact
  release candidate if a cutover change materially changes the reviewed binary.

TestFlight distribution does not prove App Store acceptance. Keep the
hybrid-only candidate out of production until a production-shaped submission
is accepted.

## Release Checklist

Before promoting the hybrid-only candidate:

1. Complete the supported macOS, Windows, Linux, headless, SSH, WSL, Direct, and
   realistic cloud Relay package/topology matrix.
2. Complete independent security review and resolve every high-severity
   finding.
3. Pass physical iPhone, Android phone, iPad, and Android tablet interaction,
   accessibility, memory, battery, thermal, and sustained-use gates.
4. Drill package and native-shell rollback on the exact store-signed release
   candidate.
5. Obtain production App Store acceptance with an accessible review Desktop and
   accurate notes.
6. Only then promote the exact accepted mobile candidate and matching Desktop
   release stream to production.
