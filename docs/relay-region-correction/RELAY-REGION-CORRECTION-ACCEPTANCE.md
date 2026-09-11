# Implementation acceptance evidence

2026-09-10. Local implementation; new correction defaults off. No production operations.
Baseline: `027acb4efa2e6b226d40df266b86367423946d62`.
Source manifest: `.tmp/region-implementation-sha256.txt`; SHA-256 `52d050db32dc670026a6d82743a009660b2eca6c2de539a26b4da135b2cce5ee`.

| Verification | Result |
| --- | --- |
| Full cloud relay suite, PostgreSQL16 on55440 enabled, serialized | 73 files /687 tests passed,0 skipped |
| Final schema/traversal/authority tests after formatting and migration addition | 4 files /101 passed,0 skipped |
| Cloud wire contract suite | 3 files /35 passed,0 skipped |
| Shipping desktop relay suite, historical `.tmp/**` excluded | 21 files /188 passed,0 skipped |
| Real two-cell WebSockets, desktop origin pool, SQLite | 2 passed,0 skipped,75.07s |
| Mobile background/grace/resume/reconnect/pairing | 5 files /42 passed,0 skipped |
| Root node and cloud relay typechecks | Passed |
| Desktop relay oxlint and new transport-test lint | Passed |
| Reliability manifest | Passed,120 gates |
| Whitespace check | Passed |

The whole changed-code-quality command reports two pre-existing curly-brace violations
in preserved `tests/tools/relay-bench/find-cell.mjs:17`. No newly implemented file is
reported. Type-aware and React Doctor scans report zero new findings. That unrelated
file is preserved rather than silently edited.

Real-transport evidence uses actual TCP WebSockets, host key proofs, control generation,
cell splices and the desktop pool. It crosses6h31m through a synthetic clock and real
heartbeat/rotation callbacks, exercises two source clients (including quiet traffic),
one target client, delayed host-side mutation exactly once, source retirement, target
failure, durable rollback and failed first director corroboration with150s of further
restored renewal. The original guarantee is that data connections and the source generation survive; ordinary authenticated rebind may replace the control socket. See the latest validation disposition below. It does not run a real
PTY, native phone, production token issuer or a six-hour wall-clock soak.

Logs: `.tmp/region-relay-full-suite-final.log`, `.tmp/region-final-targeted.log`,
`.tmp/desktop-final-shipping.log`, `.tmp/relay-ws-final-green.log`,
`.tmp/region-code-quality.log`, `.tmp/region-node-final.log`.

## Release limitations

- Physical-phone lifecycle, packaged mixed-version clients, live SSH execution and
  Linux/Windows transport runs remain release validation. No process ownership or
  workspace routing logic changed; transport loss never asserts execution exited.
- No measured production latency improvement. Sampled probe evidence and epoch-keyed
  existing control/setup telemetry support comparison; actual application-command
  latency still needs rollout observation. Probe gain alone is not user benefit.
- CI soak, numerical rollback thresholds, immutable worker rollback floor and bounded
  cohort approval remain deployment gates. All cleanup workers must support retention
  before enabling. Disabling new claims does not make old cleanup versions safe.
- Independent review and its fix follow-up are in
  [archived relay region correction implementation review](https://github.com/stablyai/orca/blob/0db9fdc486366f7451289f0c0599eed9ae1d94be/docs/relay-region-correction/RELAY-REGION-CORRECTION-IMPLEMENTATION-REVIEW.md).

## Preserved user work

Pre-existing modified package manifest is preserved in stash
`e3c15dffb043c1947b584802d69eeddb43407bf0`; it was not applied over the development
manifest required for builds. Original relay-bench files remain backed up under
`.tmp/implementation-preserved/relay-bench`, and non-overlapping `find-cell.mjs`
is preserved in place. Historical investigation/prototype files remain untouched.

## Release-readiness follow-up — 2026-09-10

- Fast-forwarded worktree to current main `74cc9b50390b481009b34823a35eee01a5b90e40`;
  kept both main's new reliability gate and this feature's gate.
- Full relay suite now74 files/691 tests passed, zero skips, with PostgreSQL16
  actually configured on55440. Deployment/workflow/preserved-setting tests55/55.
- Added exact pinned old wire parsers, unsupported optional metadata fallback,
  persisted policy guard, and real SQLite close/reopen tests. Both compatibility
  defects failed before fixes and passed afterward.
- Real transport now runs a persistent independent Node child in a non-git folder.
  Unique round-trip markers identify process/PID/cwd/sequence; a separately read
  append-once file verifies mutation execution. Held director corroboration lasts
 150s beyond the initial105s grant, with renewed authority and traffic maintained.
- Precise socket guarantee: source control socket is unchanged during retention and
  pending restoration. Ordinary post-restoration authenticated rebind may replace
  that control socket while preserving generation and existing DATA connections.
  Earlier wording suggesting the control socket never changes was too broad.
- Cloud and Electron release builds pass. Rebuilt Electron started and rendered
  onboarding in an isolated profile; all windows remained hidden/unfocused. This
  is app boot validation, not a signed/package distribution or paired-phone test.
- No Android device was connected. Physical phone, actual SSH/PTY, signed upgrade,
  Linux/Windows execution and production benefit remain unverified.
- Added bounded cohort input to the existing audited director deployment. It
  preserves live values by default, starts absent values at0 and checks disabled
  control generation for explicit changes. Terraform preserves the served value.
  No deployment/workflow dispatch occurred.

Latest commands/logs: `.tmp/region-release-full-relay.log`,
`.tmp/region-final-release-script-tests.log`, `.tmp/region-execution-validation.md`,
`.tmp/region-compatibility-validation.md`, `.tmp/region-on-main-validation.log`,
`.tmp/region-built-app-smoke-final.log` and screenshot `.tmp/region-built-app-smoke.png`.
Older source-manifest digest above is historical; final commit is authoritative.

## Current-main validation disposition (in progress)

The latest combined run on `74cc9b50390b481009b34823a35eee01a5b90e40` passed202 tests and failed1 real-WebSocket rollback test (`.tmp/region-on-main-validation.log`). Generation1 was replaced while it still owned one splice. Earlier green results above do not establish current acceptance; the replacement is under investigation. Deployment-setting ownership independently re-reviewed: APPROVE,41 tests passed0 skipped, recorded in release review.

## Current-main rollback correction — 2026-09-11

Root cause had two parts: after rollback, a restored source can become `drain-only` while awaiting director corroboration, and the relay resume predicate rejected that state, allocating a fresh generation while an existing splice remained; separately, successful corroboration cancelled the ordinary drain retry but left the restoration retry armed. `host-session-registry.ts` now permits the exact restored resume, and `relay-origin-pool.ts` cancels both retry schedules. Validation: `ORCA_BACKGROUND_LAUNCH=1 pnpm test tests/e2e/relay-region-correction.unit.test.ts` — **2/2 passed** (`.tmp/rollback-review-transport2.log`); `ORCA_BACKGROUND_LAUNCH=1 pnpm test cloud/apps/relay/src/host-session-registry.test.ts src/main/runtime/relay/relay-origin-retention.test.ts` — **11/11 passed**; relay typecheck and oxlint passed. No production operations were performed. Physical phone, SSH/PTY, packaged mixed-version, platform transport, soak, and production-benefit gates remain open.

Follow-up hardening: removed a tautological retention-attempt comparison identified by independent review; the session's authoritative retained attempt and assignment/generation checks remain enforced. Registry/origin tests remain 11/11 passing.

## Final local validation pass — 2026-09-11

- `ORCA_BACKGROUND_LAUNCH=1 pnpm test tests/e2e/relay-region-correction.unit.test.ts cloud/apps/relay/src/host-session-registry.test.ts src/main/runtime/relay/relay-origin-retention.test.ts`: **2 files / 13 tests passed, 0 skipped**.
- `pnpm tc:node`: passed.
- `pnpm --filter @orca-cloud/relay typecheck`: passed.
- Focused `oxlint` on changed relay implementation files: passed.
- `pnpm run check:reliability-gates`: **121 gates passed**.
- `git diff --check`: passed.

This validates the current-main rollback journey and focused authority/retry coverage locally. Physical phone, packaged mixed-version, live SSH/PTY, Linux/Windows transport, soak, and production latency/reliability benefit remain release gates.

## Docker SSH transport validation — 2026-09-11

`ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_SSH_DOCKER=1 pnpm exec playwright test tests/e2e/ssh-docker-transport-drop-recovery.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1`: **6 passed**, covering live pane reattach, bounded output under disconnect, replacement only after host proof of exit, repeated relay restarts, frozen-host silence, and resumed input. The earlier aggregate SSH run had one unrelated headful port-forward failure and was not used as evidence for this feature. Folder-workspace and physical mixed-platform SSH validation remain open.

## Compatibility and folder-workspace follow-up — 2026-09-11

- `ORCA_BACKGROUND_LAUNCH=1 pnpm test tests/e2e/relay-region-compatibility.unit.test.ts cloud/apps/relay/src/region-correction-restart.test.ts cloud/apps/relay/src/region-correction-state.test.ts`: **13 passed, 0 skipped**.
- `ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test tests/e2e/paired-remote-terminal-serve-restart-binding.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1`: **1 passed**. This validates a folder-capable paired runtime binding through serve restart; it does not replace live SSH or packaged mixed-version coverage.

## Mobile transport contract follow-up — 2026-09-11

`ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile exec vitest run src/transport/mobile-relay-background-grace.test.ts src/transport/mobile-relay-background-lifecycle.test.ts src/transport/mobile-relay-reconnect-controller.test.ts src/transport/mobile-relay-runtime-failover.test.ts src/transport/stable-logical-rpc-client.test.ts`: **5 files / 63 tests passed, 0 skipped**. The initial root-relative invocation accidentally included an ignored `.tmp/relay-interruption` tree and failed dependency resolution; it was not used as evidence.

## Pull request validation — 2026-09-11

Draft PR [#20031](https://github.com/stablyai/orca/pull/20031) contains the coordinated cloud/desktop implementation. CI for the corrected commit passed: Secret scan, build, Terraform, test, and test-vs-non-test LoC. No review comments or requested changes are currently present. The PR remains draft because the documented physical/platform/soak/rollout gates are not complete.

## Evidence correction and attempt validation — 2026-09-11

This section supersedes the earlier combined registry/origin and compatibility/restart
counts. The root Vitest configuration does not include `cloud/`: the reported
11 tests were desktop origin tests only, and the 13 compatibility tests did not
execute the cloud restart/store tests. Likewise, generic cross-version terminal,
agent, and browser tests are not packaged client/relay compatibility evidence.

The attempt-ID comparison removed after review was not a tautology: the nested
retention ID and outer drain request ID are distinct inputs. Restored that check.
A new registry regression was red before restoration (mismatched IDs resolved
`accepted`) and green afterward, requiring no renewal, no retention adoption,
and unchanged socket/splice state on rejection.

From `cloud/apps/relay`, with `ORCA_BACKGROUND_LAUNCH=1`:
`pnpm exec vitest run src/host-session-registry.test.ts src/region-correction-restart.test.ts src/region-correction-store.test.ts`
executed **3 files / 67 passed / 0 skipped**. Logs:
`.tmp/attempt-id-red.log` and `.tmp/cloud-authority-green.log`.

CI static-analysis logs showed the included diagnostic `find-cell.mjs` missing
braces, not a documentation-path failure. Added braces without changing behavior;
focused oxlint passes. CI remains incomplete until the new head finishes all
required desktop and cloud checks.

## CI static-analysis follow-up — 2026-09-11

CI identified and the latest commit removes a relay-region preference dependency cycle by moving the reader import to its boundary module. Focused preference/correction tests pass **35/35** and focused oxlint passes. A full local native quality scan still reports two pre-existing mobile transport cycles (`host-client-hooks.ts` and `client-context.tsx`); they are outside this change and are not modified here.

## Cloud/desktop review split — 2026-09-11

The cloud branch `relay-region-cloud` contains cloud implementation, shared wire
contracts, compatibility fixtures, deployment safeguards and cloud tests. The
desktop branch `relay-connection-speed` builds on that branch and contains desktop
lifecycle changes, real transport tests, the reliability gate and current docs.
Deploy cloud support first; correction defaults off and requires negotiated
capability, so older desktops remain on legacy behavior. Desktop release timing
does not require enabling correction.

Removed historical patches and repeated review/progress reports from the shipping
diff; the combined revision `0db9fdc486366f7451289f0c0599eed9ae1d94be` and local
`.tmp/region-split-history` preserve them. Removed a latency sort used only to
check presence; the director still owns target selection. Kept retry cancellation
and exact-generation authority checks supported by prior red/green evidence.

Split validation:

- `ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/runtime/relay/relay-region-correction.test.ts src/main/runtime/relay/relay-region-refresh.test.ts`: **2 files / 16 passed** (`.tmp/region-split-focused.log`).
- `ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node`: **passed** (`.tmp/region-split-typecheck.log`).
- `pnpm exec oxlint src/main/runtime/relay/relay-region-decision.ts`: **passed**.
- `pnpm run check:reliability-gates`: **121 gates passed**.
- From `cloud/apps/relay`: `ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run src/host-session-registry.test.ts src/region-correction-restart.test.ts src/region-correction-store.test.ts`: **3 files / 67 passed** (`.tmp/region-split-cloud.log`).
- `git diff --check`: **passed**.

Fresh split CI and the existing packaged/device/platform/production release gaps
remain required; splitting the review does not satisfy deployment gates.

### Latest transport disposition: merge blocked

`ORCA_BACKGROUND_LAUNCH=1 pnpm test tests/e2e/relay-region-correction.unit.test.ts`
returned **1 passed / 1 failed** in 127.04s (`.tmp/region-split-transport.log`).
The rollback test again timed out at line 504 waiting for
`sourceSession.regionalRestoration` to become null. The split leaves cloud and
origin lifecycle code unchanged; the new latency-sort cleanup is not exercised
by this harness. Earlier 2/2 runs therefore do not establish reliable green
transport. Investigate the remaining timer/handshake race before merge or rollout.
