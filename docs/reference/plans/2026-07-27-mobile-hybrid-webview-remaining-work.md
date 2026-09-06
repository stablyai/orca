# Mobile Hybrid WebView Remaining Release Gates

- **Status:** Candidate implementation complete; production promotion blocked
- **Completed evidence:** [evidence index](2026-07-22-mobile-hybrid-webview-implementation-checklist.md)
- **Decisions:** [migration record](2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Ownership:** [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md)
- **Runbook:** [rollback](../mobile-hybrid-webview-rollback.md)

Only genuinely open gates belong here. A gate closes only when evidence from
the exact release candidate is attached to the release record. Simulator,
emulator, Debug, locally signed, local Relay, or historical branch results do
not substitute for the environments named below.

## Completed Candidate Summary

The candidate has deterministic authenticated RNW packaging, independent native
verification, host-scoped active/previous cache generations, private iOS and
Android origins, exact bridge v2 named capabilities, opaque authority, shared
React Native presentation, hybrid-only workspace routing, and explicit native/
Desktop ownership. Direct, Docker SSH, actual iOS WKWebView, emulator isolation,
corrupt-cache/process-loss recovery, and protocol-compatible local Relay
composition have recorded evidence. The 2026-08-21 independent OpenCode review
was completed and its high-severity findings were fixed. The 2026-08-23
concurrency follow-up also fixed overlapping branch-comparison continuations,
native-alert package replacement, and rapid Android Back traversal races.

Latest recorded package:
`12df9ad54b240dd8ec9ef97b2e00c971536b0d05ca6c0c1834d47bbd509480ca`,
52 assets, 9,310,634 raw bytes, 2,691,771 gzip bytes. This summary is not a
production-readiness claim.

## 2026-08-30 Complexity Audit Follow-up

The focused audit removed accidental duplication introduced while adapting the
native presentation to hosted operation adapters:

- The host route is now a 27-line wrapper around the shared presentation and an
  adapter-aware controller; its temporary max-lines exception was removed.
- `NewWorktreeModal` is now 378 lines. Repository/runtime/SSH/setup/create
  behavior lives in operation-based hooks, and its max-lines exception was
  removed without changing the existing form or drawer components.
- `src/main/git/runner.ts` is restored to the modular command-runner entrypoint
  (44 lines), removing a 2,176-line duplicate implementation.
- The React Doctor browser warning caused by render-phase address/zoom state
  synchronization was removed; changed-code quality, typechecks, focused
  lint, 40 focused mobile tests, and 35 Git command-runner tests pass.
- The GitHub stdin regression exposed by the focused suite is fixed by
  forwarding `stdin` through `ghExecFileAsync`.

The browser complexity item is closed. `MobileBrowserPane` now delegates
rendering, streaming, interactions, layers, and request translation to focused
modules through an adapter-aware `HostSessionBrowserOperations` bridge. Browser
source, adapter, stream, frame, and interaction tests pass, and the pane is
below the normal TSX max-lines cap with no file-specific exception.

The adapter-heavy Tasks route remains intentionally unchanged for now. The
latest `main` Tasks extraction does not expose the operation props required by
the hosted WebView route; adopting it would either break hosted behavior or
require a separate operation-context migration. It remains the only new
mobile-config max-lines baseline entry in this candidate.

## 2026-08-31 Parallel Review Follow-up

The second independent Codex review wave found and corrected four candidate
regressions before merge:

- Notification taps again honor missing-credential re-pair and temporary
  credential retry recovery instead of always entering the hosted route.
- Missing-worktree notices survive the retired native-route redirect and Home
  Resume flow through the typed hosted navigation route.
- Host changes fence the old package session before a new host broker or WebView
  can become active.
- Desktop package-scope classification now runs Linux/Windows package checks
  when shared `mobile/app/h/**` routes change.

The same review identified follow-ups that are not yet release blockers but
need explicit disposition before production promotion: bounded native package
session retention and retry-safe stage cleanup; an iOS delayed navigation
failure generation token; broader two-host LAN/Relay/SSH/WSL/folder coverage;
and restoring rendered Tasks/accessibility parity tests while removing the
remaining Tasks duplication. These remain tracked by the corresponding gates
below and are not silently considered complete.

## 2026-09-01 CI Coverage Note

- The Swift and Kotlin native store suites now run in CI from
  `.github/workflows/mobile-native-shell-tests.yml`, on a macOS runner and an
  ubuntu runner with the Android SDK. This closes no gate above; the suites
  compile and exercise store sources, not a store-signed release app.
- `tests/e2e/hosted-mobile-webview-ssh.spec.ts` is explicitly excluded from the
  ubuntu changed-spec e2e lane in `.github/workflows/e2e.yml`. It needs an iOS
  simulator and a Docker daemon at once, which no GitHub-hosted runner offers,
  and it skipped itself off darwin there. Reporting that green skip as coverage
  hid the fact that CI never runs it. It runs from a macOS checkout through
  `pnpm test:e2e:hosted-mobile-webview:ssh`.

## Packaged Desktop and Signed App Matrix

- [ ] Build, install, and run package delivery from the final supported macOS
      artifact, including final signing/notarization.
- [ ] Build, install, and run the final supported Windows artifact.
- [ ] Build, install, and run the final supported Linux artifact at the glibc
      floor.
- [ ] Validate the supported headless Desktop/package-serving runtime.
- [ ] Run final CI, packaging, signing, notarization/store verification, and
      record exact Desktop/mobile commits, artifact identities, package build
      ID, commands, and logs.
- [ ] Run the exact hostile-content and privacy corpus in production-store-signed
      iOS and Android release apps.

## Physical Devices and Layouts

- [x] Re-run the corrected iPhone Simulator native-versus-hosted fixture for
      Source Control/Review, including host-origin navigation and a second
      session-origin Source Control mount.
- [ ] Re-run the corrected iPhone Simulator native-versus-hosted fixture for
      Workspace, Accounts, Tasks, Session, Agent History, Files/Preview, host
      editing, Floating Workspace, and recovery. Require
      CDP proof that no hosted private-origin target exists around each native
      capture and replace the invalidated historical screenshot metrics.
- [ ] Test the oldest supported low-memory and current iPhone.
- [ ] Test the oldest supported low-memory and current Android phone/API.
- [ ] Test a supported physical iPad and Android tablet/large-screen layout.
- [ ] Cover cold start, reconnect, background/foreground, repeated WebView loss,
      memory pressure, attachment permission/denial/revocation/interruption,
      notification/deep-link routing, rotation, and host/session replacement on
      those devices.
- [x] Validate Android hardware Back from nested Agent History through Session
      and workspace root to the native shell on the current API 36 emulator,
      using real `KEYCODE_BACK` input and a clean bridge-log audit.
- [ ] Validate Android hardware Back at dirty drafts, timeout, reconnect, mixed
      Desktop/mobile versions, and on a physical device.
- [ ] Validate native Alert button ordering, dismissal, queueing, destructive
      actions, and old-shell fallback on iOS and Android release candidates.

## Topology and Compatibility

- [ ] Validate production cloud Relay with realistic latency, disconnect,
      reconnect, ambiguous delivery, host change, and multi-host races.
- [ ] Complete Direct, native, SSH, WSL, Relay, folder workspace, and git
      worktree coverage without local execution fallback.
- [ ] Exercise broader live cross-host, cross-build, cross-workspace,
      cross-session, replay, process-loss, host-removal, cancellation, and
      replacement races.
- [ ] Test at least two differently versioned Desktop/mobile combinations in
      both directions and complete the supported mixed-version matrix.
- [ ] Verify additive bridge capabilities negotiate safely, incompatible
      versions fail closed with recovery, and the two-stable-mobile-release
      protocol-floor policy is supportable.

## Accessibility and Input

- [ ] Complete VoiceOver and TalkBack review for every owned route, dialog,
      alert/live region, toolbar control, error, and recovery state.
- [ ] Validate software and hardware keyboards, focus order/restoration,
      shortcuts, selection, clipboard, and terminal IME composition on both
      platforms.
- [ ] Validate Dynamic Type/text zoom, reduced motion, orientation, safe areas,
      phone/tablet gestures, pickers, dictation, and interruption behavior.
- [ ] Resolve or explicitly disposition the missing accessibility labels noted
      in the [parity inventory](2026-07-22-mobile-hybrid-webview-parity-inventory.md).

## Performance and Endurance

- [x] Implement capability-negotiated per-chunk gzip delivery with raw-chunk
      fallback for older Desktop/mobile combinations. The current 9,310,634
      byte package measured 2,813,625 compressed asset bytes and approximately
      3,833,990 bytes of gzip JSON responses (240 chunks), before E2EE framing.
      Focused downloader, provider, contract, and real local-Relay integration
      tests pass. Binary framing and Brotli remain deferred follow-ups.
- [x] Report verified source-byte download progress through the native loading
      state, including accessible percentage/byte labels and verification /
      activation phases. Background refreshes retain the current interface while
      showing progress unobtrusively.
- [ ] Measure cached startup and route restoration on low-memory physical iOS
      and Android devices against the current native baseline.
- [ ] Measure terminal input latency, output frame pacing, ACK/backpressure,
      scrollback, memory, hidden panes, reconnect, and multiple simultaneous
      streams.
- [ ] Measure large file/diff/review behavior, attachment and image previews,
      memory pressure, battery, thermals, and GPU use.
- [ ] Pass at least 30 minutes of sustained use plus repeated
      host/session/terminal/diff/process-loss cycles without progressive memory,
      latency, battery, or thermal degradation.
- [ ] Attach raw benchmark commands, device/build metadata, logs, traces, and
      comparisons to the final release record.

## Security Residuals

- [ ] Complete exact store-signed release-app content/privacy corpus coverage.
- [ ] Run broader live multi-host and authority-revocation races across the
      supported topology matrix.
- [ ] Complete sustained allocation fuzzing at manifest, chunk, bridge,
      subscription, terminal, diff, file, and cache boundaries.
- [ ] Audit final release privacy manifests, entitlements/permissions,
      diagnostics, logs, analytics, crash reports, and support exports.
- [ ] Reconcile all security findings and mitigations against the exact final
      commits and artifacts.

## Rollback Release Drills

- [ ] On final physical/store-signed candidates, drill corrupt active content,
      automatic previous-generation recovery, repeated process loss, manual
      host-scoped previous-generation recovery, incompatible bridge,
      disconnection, host removal, and cache clearing.
- [ ] Rehearse a Desktop package incident: stop the affected rollout and serving
      the rejected build, then ship verified known-good content in a corrected
      higher-version Desktop release.
- [ ] Rehearse a native-shell incident: use store/OTA controls to contain new
      exposure and ship a corrected higher-version native release for devices
      that already installed the bad version.
- [ ] Verify support never edits `activation.json` or cached generations and
      does not describe cache clearing as Desktop rollback.

OTA/channel pointer rollback is not a reliable downgrade for clients that
already installed a bad update. Byte-identical restored Desktop content may
reuse its prior content-addressed build ID; changed content must not. The
[rollback runbook](../mobile-hybrid-webview-rollback.md) is authoritative.

## App Review and Promotion

- [ ] Provision an internet-accessible review Desktop with durable test
      credentials, representative data, sample QR code, and exact pairing and
      recovery instructions.
- [ ] Prepare accurate review notes describing Desktop-served workspace UI and
      the shell's meaningful native pairing, security, notification, recovery,
      permission, and device capabilities.
- [ ] Submit the production-shaped build through App Review; TestFlight does not
      close this gate.
- [ ] Record reviewer questions, requested changes, disposition, and acceptance.
- [ ] Attach reconciled parity, automated/manual test, physical-device,
      topology, compatibility, accessibility, benchmark, security, rollback,
      signing, screenshots, App Review, and support artifacts.
- [ ] Confirm the final code, architecture, parity ownership, release notes,
      runbook, and evidence describe the same candidate before promotion.

Production promotion remains blocked until every item above passes or is
removed by an explicit approved design decision.
