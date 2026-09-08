# Mobile Hybrid WebView Migration Record

- **Date:** 2026-07-22
- **Status:** Implemented candidate; production promotion gates remain open
- **Decision:** Use a stable native shell with a Desktop-served React Native Web
  workspace package
- **Related:** [architecture](../mobile-hybrid-webview-architecture.md),
  [rollback](../mobile-hybrid-webview-rollback.md),
  [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md),
  [completed-work evidence](2026-07-22-mobile-hybrid-webview-implementation-checklist.md),
  [open gates](2026-07-27-mobile-hybrid-webview-remaining-work.md)

> **2026-09-02 — the recent-user-gesture window described below was removed.** The
> shell no longer requires a recent native touch before a bridge capability runs: a
> scroll armed the window, so it gated nothing on a first-party page, and peer hybrid
> frameworks do not gate bridge calls this way. Gesture statements here describe the
> plan as written, not the shipped shell.

## Context

The original mobile application duplicated fast-changing Desktop workspace
behavior in a native route tree. The migration evaluated a remotely delivered
workspace surface while retaining a stable store-distributed shell. The
prototype proved delivery and bridge feasibility but did not satisfy production
authority, package, parity, or lifecycle requirements.

The implemented candidate packages the existing React Native mobile
presentation as React Native Web. The paired Desktop builds and serves that
package; the shell verifies and hosts it on a private origin. This is not a
second DOM/shadcn product UI. Source/component identity is the preservation
contract, with screenshots and interaction tests as supporting evidence.

## Decision

Adopt the hybrid architecture conditionally:

1. A stable Expo/native shell owns pairing, credentials, encrypted transport,
   package verification and cache, the private origin, recovery, notifications,
   deep links, permissions, clipboard, pickers, haptics, audio, settings, and
   diagnostics.
2. The Desktop-served React Native Web package owns workspace, session,
   terminal, files, source control, reviews, tasks, accounts, browser, and
   native-chat presentation.
3. Desktop remains authoritative for workspace execution. It resolves every
   opaque handle, reauthorizes every operation, and retains provider, Git,
   filesystem, terminal, WSL, SSH, and Relay ownership.
4. The unchanged React Native presentation is shared between native and hosted
   adapters. A visually similar replacement does not count as parity.
5. Candidate Desktop and mobile channels remain isolated from production until
   all gates in the [remaining-work tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md)
   pass.

The dedicated hybrid candidate has no native workspace fallback. The shared
tree also supports a native-default release mode so daily mobile builds remain
unchanged while the candidate is tested. Native shell routes remain for
connection and device responsibilities; hybrid workspace destinations enter
the hosted route.

## Rejected Alternatives

### Continue the duplicated native workspace

This retains store-release coupling and two independently evolving workspace
implementations. It remains a rollback boundary for older releases, not the
candidate architecture.

### Build a parallel web presentation

This would create a third parity surface and violate the source-identity
contract. The migrated package uses the existing React Native screens and
components.

### Expose generic RPC or native invocation

A method allowlist alone does not preserve operation-specific request/result
schemas, bounds, authority, gesture mediation, mutation reauthorization,
correlation, or subscription cleanup. Generic `rpc.call`, `invoke`, transport,
filesystem, provider, and terminal passthroughs are forbidden.

## Ownership

The [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md) is
the canonical route, operation, subscription, native-capability, persisted-state,
UX-state, and accessibility ownership ledger. In summary:

| Surface                                                                                     | Owner                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------- |
| Pairing, host selection, connectivity, onboarding, notifications, settings, troubleshooting | Native shell                            |
| Workspace and session route presentation                                                    | Hosted React Native Web app             |
| Workspace execution and mutation authorization                                              | Desktop execution host                  |
| Permissions, clipboard, pickers, haptics, audio, external navigation                        | Native shell through named capabilities |
| Package build and serving                                                                   | Paired Desktop                          |
| Package verification, activation, recovery, and private origin                              | Native shell                            |

Folder workspaces and git worktrees are equal workspace kinds. Provider-neutral
review behavior must preserve GitLab and other supported providers. Native,
WSL, SSH, and Relay execution remain owned by the host on which execution
occurs; loss of contact is never evidence that remote work exited.

## Security Invariants

### Authority

- Page authority is an opaque, shell-session-scoped token. It contains no path,
  credential, endpoint, durable host identity, provider target, or terminal
  handle.
- Host, build, shell session, workspace, stream, continuation, and gesture
  authority is bound together and revoked on switch, reconnect, client/process
  loss, cancellation, replacement, pairing removal, and foreground loss where
  applicable.
- Desktop validates the current paired connection, workspace, provider, path,
  Git capability, mutation precondition, and execution host on every operation.
- Named operations have exact schemas, stable errors, input/output bounds,
  concurrency/rate limits, and explicit cancellation or cleanup.
- Destructive or privilege-bearing native actions require current foreground,
  route, permission, and user-gesture authority. Results cannot be replayed into
  another request or shell session.
- Subscriptions and terminal streams have bounded buffers, ordered correlation,
  explicit cleanup, reconnect snapshots, and late-result rejection.

### Package and origin

- The package is content addressed and authenticated. Desktop generation and
  native verification independently validate the manifest, hashes, paths,
  MIME/role mapping, CSP, sizes, counts, and exact JSON.
- Activation is atomic and host scoped. Only verified `active` and optional
  distinct `previous` generations are retained; cache files and activation
  metadata are never page writable.
- All reads and writes reject traversal, symlinks, linked ancestors, unexpected
  types, oversized data, duplicate JSON keys, trailing input, malformed Unicode,
  and excessive nesting before allocation or activation.
- iOS serves `orca-mobile-web://<session>/`; Android serves
  `https://orca-mobile-web.invalid/`. The origin contains no credential or host
  identity.
- CSP, native navigation delegates, Android URL interception, and request
  policy deny network, popup, download, service-worker, undeclared executable,
  and navigation escape. Only manifest-declared content-addressed assets load.
- Browser persistence is unavailable to executable page code. Credentials,
  endpoints, host-local paths, page payloads, terminal content, and full build
  identity must not enter URLs, DOM state, storage, cache keys, logs,
  diagnostics, analytics, crash metadata, or fixtures.

### Wire compatibility

The first production contract is exact bridge v2. Additive operations remain
on v2 and require capability negotiation. New stream opcodes require explicit
capability negotiation because old decoders may silently drop them. A breaking
change requires a new native version; its predecessor remains supported for at
least two stable mobile releases and until the supported shell minimum advances.
Desktop and mobile versions must fail closed with actionable incompatible-build
recovery.

## Package and Runtime Record

The deterministic build emits a manifest, document, content-addressed assets,
and size report. The independent verifier is part of Desktop packaging.
Supported entry commands are:

```sh
pnpm build:mobile-web-rnw
pnpm typecheck:mobile-web
pnpm lint:mobile-web
pnpm test:e2e:hosted-mobile-webview
pnpm test:e2e:hosted-mobile-webview:ssh
pnpm test:e2e:hosted-mobile-webview:ssh:packaged
```

The final recorded independently verified package was
`5eda0f5c7f5265e9be2420d9178c03605dbe4c8e5ea9e669327d680f1e9c0eb3`:
52 assets, 9,308,959 raw bytes, and 2,691,373 gzip bytes. A packaged macOS arm64
Desktop to Docker SSH to actual iOS WKWebView journey used package
`7c7c673deb74e158cdfb99b1ca536fd88cd3ab5dac4eb8db78c43ca12f6ce31d`
without checkout fallback.

These are candidate artifacts, not evidence for Windows, Linux, headless,
production signing, physical-device, cross-version, production cloud Relay, or
performance gates.

## Completed Migration Scope

- Replaced prototype delivery with production package RPC, independent package
  verification, private origins, and atomic host-scoped cache recovery.
- Removed the duplicate web presentation and retired prototype route,
  contracts, settings flag, and persisted state.
- Cut all workspace destinations over to the production hosted route while
  retaining native connection and device routes.
- Shared workspace, Accounts, Tasks, Session, Files/Preview, Agent History,
  Source Control, Review, terminal, browser, attachments, and native-chat
  presentation through explicit native/web adapters.
- Negotiated Android hardware Back and native Alert presentation so hosted
  routes retain current shell behavior and mixed versions degrade safely.
- Bound files, source control, provider review, tasks, agent mutations,
  terminal streams, browser controls, native chat, and continuations to opaque
  current authority.
- Added exact schema/bounds coverage, hostile-content isolation, cache
  corruption/concurrency recovery, process-loss rollback, Direct and SSH
  integration, and local protocol-compatible Relay composition.
- Completed an independent OpenCode review on 2026-08-21 across bridge, native
  shell, package store, runtime RPC, Relay, and SSH boundaries and fixed its
  high-severity findings.

The detailed completed-work and commands are indexed in the
[implementation evidence](2026-07-22-mobile-hybrid-webview-implementation-checklist.md).
Simulator/emulator and locally signed results do not substitute for the open
release gates.

## Rollout and Rollback

Desktop package rollout and native-shell rollout are separate boundaries. The
[rollback runbook](../mobile-hybrid-webview-rollback.md) is authoritative.

For a Desktop package regression, stop the affected Desktop rollout and stop
serving the rejected build. Ship verified known-good content in a corrected,
higher-version Desktop release. Byte-identical restored content may reuse its
previous content-addressed build ID; changed content must not.

For a native-shell defect, store controls only limit further exposure. Ship a
corrected higher-version native release for devices that installed the bad
binary. OTA/channel pointer rollback can contain clients that have not installed
the bad update; it is not a reliable downgrade for clients that already have.

Never edit `activation.json` or cached generations manually. Cache clearing is
recovery, not Desktop rollback: it downloads the same bad package again while
Desktop continues serving it. Automatic fallback and manual previous-generation
recovery remain host scoped and verified.

## Consequences

Workspace UI can evolve with Desktop while credentials and device privileges
remain outside page authority. The tradeoff is a larger versioned security
boundary: package delivery, native hosting, explicit capability adapters,
mixed-version support, and dual Desktop/native incident response become release
responsibilities.

The implementation is complete as a candidate, but production promotion is not.
Physical devices, store-signed releases, supported packaged Desktop platforms,
production cloud Relay, cross-version combinations, accessibility/input,
sustained performance, final rollback drills, and App Review remain open in the
[remaining-work tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md).
