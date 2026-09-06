# Mobile Hybrid WebView Simplification Audit

- **Date:** 2026-08-23
- **Status:** Simplifications integrated; release validation remains
- **Candidate checkpoint:** `e931b2db07`
- **Base and `origin/main` checkpoint:** `4c984d4c1b`
- **Post-audit integration checkpoint:** `b8d04428c0`
- **Current `origin/main` checkpoint:** `e50cc309c3`
- **Decision record:** [migration record](2026-07-22-mobile-hybrid-webview-single-pr-migration.md)
- **Release gates:** [remaining-work tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md)

## Outcome

The chosen stable-shell/Desktop-served-RNW architecture remains justified. The
audit validated removals and test consolidation opportunities, but did not find
a safe replacement for the explicit capability and authorization boundary.

The proposed generic RPC adapter is rejected. A declarative operation registry
is approved only as a follow-up that generates mechanical wiring around the
existing explicit domain adapters and authorization. It is not a prerequisite
for documentation condensation or release-gate execution.

## Scope and Method

The audit reviewed the migration differential, production entry points, package
and native origin implementations, shared bridge contracts, native broker and
Desktop execution adapters, route adapters, validation infrastructure, and
security/lifecycle tests. The checkpoint comparison was 81 commits, 1,396
files, 140,153 additions, and 8,772 deletions. Those counts describe
`4c984d4c1b...e931b2db07`; they are not current-main release metrics.

After the approved reductions, fixes, and current-main merge, the comparison is
92 commits, 1,401 files, 134,633 additions, and 8,771 deletions relative to
`e50cc309c3`. Documentation condensation accounts for most of the reduction;
the explicit 225-operation bridge and shared RNW presentation remain the main
implementation span.

The non-negotiable constraints were:

- Preserve the existing React Native presentation and behavior.
- Keep page authority opaque and the private origin network/storage isolated.
- Preserve exact named operations, per-operation schemas/bounds,
  reauthorization, result correlation, and cleanup.
- Preserve native, folder-workspace, WSL, SSH, Relay, provider-neutral, and
  mixed-version ownership even where their final matrices remain open.
- Remove tests only when equivalent or stronger coverage remains.
- Prefer fewer concepts and a smaller trusted surface over a line-count target.

## Reviewed Commit Groups

| Area                            | Representative commits                                                             | Review conclusion                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Initial migration               | `9834f65552`                                                                       | Established package, private-origin, bridge, hosted route, and shared-UI direction; later hardening was required     |
| Route and presentation parity   | `3feb8bf332`, `abaa3e59bf`, `8cec2462d8`, `ab97f84485`, `d2fbda1d2f`, `e253d13a48` | Shared source and explicit adapters are the durable design; no parallel presentation should return                   |
| Native authority and privacy    | `328617b8e8`, `8ee4fcdac1`, `d6b8b14c82`, `f2a6a5d8b6`                             | Opaque shell authority and removal of page-owned credentials/package persistence are mandatory                       |
| Package/cache hardening         | `417197f109` through `0a247f9743`                                                  | Exact parsing, pre-allocation bounds, symlink/path defense, atomic activation, and native parity remain required     |
| Compatibility and cleanup       | `a7dcd591b9`, `548d8d64aa`, `b1e067a321`, `0a91c04a49`                             | Duplicate UI/prototype removal, bridge v2 policy, corrected rollback, and gated cutover are durable                  |
| Lifecycle and adversarial proof | `e526780848`, `b2068661f7`, `ed31999634`, `279a1ff68e`                             | Request/subscription lifecycle, response binding, automatic rollback, and hostile-content tests cover distinct risks |
| Latest-base revival/cutover     | `4a4aaf91b6`, `ce43d114be`                                                         | Production entry remains hybrid-only while native connection/device routes stay owned by the shell                   |
| Audit and merge checkpoint      | `06f23ec818`, `e931b2db07`                                                         | Audit proposal and latest-main merge are the baseline for the findings below                                         |

The ranges above are review groupings, not assertions that every intermediate
commit is independently releasable.

## Validated Findings

### Keep

- One shared React Native presentation with native and hosted adapters. The
  duplicate web presentation and prototype route/contracts are correctly gone.
- Native-owned pairing, credentials, transport, package verification/cache,
  private origin, recovery, permissions, device capabilities, settings, and
  diagnostics.
- Desktop-owned execution and reauthorization for native, WSL, SSH, Relay,
  folder/git workspace, filesystem, Git/provider, terminal, and session work.
- Exact bridge v2, capability negotiation for additive changes/new stream
  opcodes, and the two-stable-mobile-release floor-retention policy.
- Content-addressed authenticated packages, independent native verification,
  atomic host-scoped active/previous generations, strict CSP/navigation/storage
  isolation, and bounded exact parsing.
- Explicit domain adapters and cleanup paths for workspace, session, terminal,
  files, source control/review, tasks, accounts, browser, native chat, and native
  capabilities.

### Confirmed simplifications

- Hosted code no longer imports native authority implementations; platform
  modules are aliased to disabled page stubs where required by bundling.
- Prototype and retired route/contract names are guarded from production roots.
- Duplicate React Native Web presentation code was removed instead of retained
  behind a switch.
- Bridge request/envelope limits and native-source assertions are aligned.
- Cache symlink, path, exact-JSON, scalar, Unicode, size, and parser hardening
  closes concrete native divergence rather than adding generic abstraction.
- Android root-route/session/handshake fixes, SSH transcript execution-owner
  repair, and packaged resource lookup validation address real boundary defects.
- Repeated roundtrip test setup and confirmed unreachable exports/files can be
  consolidated or removed without weakening production behavior when their
  focused validation remains.

### Do not collapse

- Native capability execution and Desktop workspace execution are different
  trust boundaries even when both use the same page transport envelope.
- Package delivery RPC is separate from page capability dispatch.
- Terminal streaming, native-chat subscriptions, ordinary request/response,
  and native device actions have different lifecycle rules.
- iOS and Android origin/cache implementations may share contracts and corpora,
  but their platform enforcement remains explicit.
- Desktop package rollback and native-shell/store correction are independent
  operational procedures.

## Rejected Generic-RPC Design

The proposed smaller adapter would preserve more of `RpcClient` behind a method
allowlist. It is rejected because the allowlist proves only a method name. It
does not, by itself, preserve:

- operation-specific page request and result schemas;
- pre-allocation collection, string, binary, and envelope limits;
- opaque host/build/shell/workspace/stream authority binding;
- destructive mutation reauthorization after asynchronous host resolution;
- foreground, route, and permission mediation;
- request/result identity and delayed-response correlation;
- subscription ownership, cancellation, invalid-event retirement, and
  reconnect resnapshot;
- provider, Git, filesystem, terminal, WSL, SSH, and Relay execution ownership.

Wrapping arbitrary `sendRequest(method, params)` would broaden page authority
and the trusted parsing surface. Generic `rpc.call`, native `invoke`, and raw
transport/stream passthrough remain forbidden even if their method names are
allowlisted.

## Declarative Registry Decision

A declarative registry is an approved non-blocking follow-up if it reduces
manual synchronization without changing authority. It may define or generate
mechanical operation metadata, typed page clients, grant/schema associations,
dispatch tables, compatibility declarations, and invariant tests.

It must not generate or hide authorization decisions. Each domain retains an
explicit adapter that resolves opaque authority, checks the current execution
host and provider/workspace context, reauthorizes mutations, mediates native
permission state, applies result-specific bounds, and owns cleanup.
Generated output must remain reviewable, deterministic, exact-v2 compatible,
and covered by the existing malformed/lifecycle corpora. Prototype this on
Tasks, Files, and Session before any broad conversion.

## Integrated Audit Workstreams

| Workstream                 | Integrated commit | Result                                                                                                                                                             |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dead-code reachability     | `35630bd1db`      | Added a focused mobile Knip audit and removed only confirmed unreachable providers, aliases, exports, and fixtures                                                 |
| Validation consolidation   | `0820c97a15`      | Replaced repeated bridge roundtrip setup with one real broker/page/shell fixture while preserving authority, correlation, revocation, and disposal coverage        |
| iOS cache boundary         | `9b9c76222f`      | Prevented host-root symlink traversal across staging, activation, cleanup, sessions, removal, and quota accounting; added adversarial Swift coverage               |
| Documentation condensation | `bc99618482`      | Reduced four execution-era records to the migration decision, completed evidence, remaining gates, and this audit                                                  |
| Parity and cutover seams   | `7815f3afb3`      | Preserved native host editing, made workspace routes hybrid-only, removed the hosted picker duplicate, added test-only native baselines, and negotiated host gates |
| Subscription regression    | `ee15298704`      | Restored the shared bridge envelope used by subscriptions after the parity refactor exposed a removed-method call                                                  |
| Parity bounds              | `2094dde1f9`      | Made native CDP exclusion fail closed above its inspection limit and expanded the bounded session-capability response allowance                                    |
| Relay process boundary     | `c3725a60fc`      | Moved Relay Markdown discovery to the shared cross-platform process launcher and preserved the child-process import ratchet                                        |

No declarative registry prototype was built.
`src/shared/mobile-web/bridge-operation-registry.ts` is an operation-name list
with a capability enum and a membership check; `bridge-contract.ts` and one
focused test were its only consumers. Nothing about metadata, grants, or typed
calls was generated, so the claim that a Tasks/Files/Session prototype proved
generation is withdrawn. Converting all 225 operations in this PR would
increase review and compatibility risk, so the registry remains an unstarted
non-blocking follow-up.

## Living Checklist

- [x] Record exact audit base, candidate, differential, and representative
      commits.
- [x] Preserve durable architecture, security, compatibility, ownership, and
      rollback decisions in the migration record.
- [x] Reject the generic-RPC/native-invocation design.
- [x] Approve declarative mechanical wiring only as an explicit-domain-adapter
      follow-up.
- [x] Integrate confirmed dead-code and repeated-test-fixture reductions with
      focused validation.
- [x] Integrate and validate the iOS host-root boundary fix.
- [x] Complete the parity-cutover audit without changing the shared
      presentation.
- [ ] Prototype the declarative registry on Tasks, Files, and Session. Not
      started; the registry file remains an operation-name list and broad
      conversion stays deferred.
- [x] Rerun deterministic package verification, full mobile/root suites,
      typecheck/lint, bridge/cache/security suites, and diff hygiene after
      integrated simplifications.
- [x] Rerun corrected Source Control/Review native-versus-hosted emulator parity,
      including host-origin navigation and the second session-origin mount.
- [ ] Complete corrected native-versus-hosted emulator parity for the remaining
      route matrix after integrated simplifications.
- [ ] Keep the [release-gate tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md)
      current; do not promote simulator/local evidence into physical, store,
      production cloud Relay, mixed-version, performance, or App Review proof.

## 2026-09-01 Cleanup Addendum

A follow-up branch removed accidental complexity this audit did not catch and
restored the parts of `main` the migration had inlined. Work is referenced by
merge subject rather than SHA, because the branch is still rebased.

`Merge mr-p1-deps: restore dependency versions and wire Android WebView patches`

- Mobile dependency downgrades are back at `main`'s versions.
- The Android WebView debugging patches now actually apply. They are declared
  in `mobile/pnpm-workspace.yaml` against the installed versions instead of an
  inert `mobile/package.json` block.

`Merge mr-p1-registry: register creationRetiredNames and type bridge operation names`

- `workspace.creationRetiredNames` is registered.
- Page request clients are typed against the registry, and a census test
  asserts that every operation a page request client names is registered.

`Merge mr-p1-security: broker teardown on restart, Android network blocker, alert gesture gate`

- A WebView process restart below the crash-loop threshold now retires and
  rebuilds the capability broker through a `viewEpoch` remount.
- Android installs a document-start script denying `fetch`, `XMLHttpRequest`,
  `WebSocket`, and `serviceWorker`, matching iOS.
- The `native.alert` gesture gate this group added was deleted on 2026-09-02,
  along with the whole recent-user-gesture window: a scroll armed it, so it
  gated nothing on a first-party page. The rest of this group stands.

`Merge mr-p1-ci: run native shell tests in CI and fix the Android module build`

- The Swift and Kotlin store suites run from
  `.github/workflows/mobile-native-shell-tests.yml`.
- The Kotlin module's compile errors and a stage-symlink defect were fixed
  first.

`Merge mr-p1-cleanup: drop dead modules, stale overrides, and duplicated guards`

- Unreferenced renderer and bridge modules are gone, along with the max-lines
  overrides for files that shrank.

`Merge mr-p2-tasks: restore the Tasks route as a hook composition`

- The Tasks route is 80 lines again, down from 14,452, with the hosted
  operations delta threaded through restored stage hooks and
  statement/render-token parity oracles re-frozen.
- Its max-lines baseline entry and the modules the inlined screen orphaned were
  removed.

`Merge mr-p2-session: restore the split session route and RPC client`

- The session route is 10 lines, down from 4,984, and `rpc-client.ts` is 64
  lines, down from 1,202.
- Both are back on `main`'s decomposition with the hybrid delta re-applied.

This addendum records completed cleanup. It does not change the audit's
conclusions and closes no gate in the
[release-gate tracker](2026-07-27-mobile-hybrid-webview-remaining-work.md).
