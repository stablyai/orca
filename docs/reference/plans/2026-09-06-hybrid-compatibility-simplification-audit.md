# Hybrid compatibility simplification audit

Audited September 6, 2026 at `6e949ece6c0`, branch `mobile-rearch`.
Removal plan implemented September 6, 2026; the gate, export, and emulator results
recorded below predate the later bounding corrections and must all be rerun.
Findings below describe the audited checkpoint and motivate the completed changes.

## Decision

Hybrid has no released users. Preserve released native mobile → new Desktop
compatibility. New hybrid → old Desktop may stop with the existing Update Desktop
UI. Do not support hypothetical earlier releases of this PR's hybrid shell/page.

Keep the generic bridge and Desktop-owned product logic. Remove the duplicate
hybrid paths once the first-release baseline is enforced. No protocol bump is
needed merely to clean up an unshipped bridge; keeping its current number is fine.
After hybrid ships, its shell/page contract becomes a real compatibility boundary.

## Findings

### 1. Removable hybrid fallback selection

These page clients explicitly choose a generic operation or an older hybrid bridge
operation. They do not provide the RPC surface used by released native apps.
Paths below are relative to `src/mobile-web/src/`.

| Area                                        | Files                                                                                                                                                                       | Simplification                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File list/search/text/directory/chunk reads | `mobile-web-file-request-client.ts`, `mobile-web-file-read-request-client.ts`                                                                                               | Remove legacy closures and unsupported-host/shell fallback. Keep page-side validation, file presentation and decoding. Invalid input should fail directly.        |
| Source Control status/diff                  | `mobile-web-source-control-read-request-client.ts`                                                                                                                          | Use generic host reads directly. Keep page presentation and bounded results.                                                                                      |
| Source Control watch                        | `mobile-web-source-control-host-subscription.ts`                                                                                                                            | Keep one host subscription; remove switching to the shell-owned subscription. Preserve cancellation, ready and cleanup.                                           |
| Native-chat reads/feed/mutations            | `mobile-web-host-native-chat-read.ts`, `mobile-web-host-native-chat-subscription.ts`, `mobile-web-host-native-chat-mutation.ts`, `mobile-web-native-chat-request-client.ts` | Require baseline host binding/forwarding. Remove legacy operation selection. Keep private-resource resolution, current-document authority and mutation deadlines. |
| Native-chat file actions                    | `mobile-web-native-chat-file-client.ts`                                                                                                                                     | Require page tab identity for host binding; remove fallback to shell file adapters. Check all call sites before tightening the API.                               |
| Session agent discovery and creation        | `mobile-web-session-terminal-creation.ts`, `mobile-web-session-request-client.ts`                                                                                           | Remove legacy callbacks and old-shell constructor default. Retain workspace injection, mutation ID, deadline and no retry after ambiguous creation.               |
| Terminal clear/rename/display mode          | `mobile-web-host-terminal-actions.ts`, `mobile-web-terminal-request-client.ts`                                                                                              | Make host metadata binding required, remove feature-selected legacy metadata actions. Keep terminal binary/input/device lanes.                                    |

Ten principal files in this table total 1,202 lines. That is an inspection
footprint, NOT deletable lines or an estimate of time spent: those files also
contain necessary implementation. This audit does not justify a percentage claim.

### 2. Remove obsolete shell branches after their callers

`mobile/src/mobile-web/mobile-web-production-grants.ts` still advertises both
host forwarding and domain-specific operations. Delete only superseded operation
entries, dispatcher branches and dead projections, not whole families blindly.

Concrete follow-up locations:

- `mobile-web-file-operations.ts`: superseded read/list/search operations.
  File write/open/artifact operations still have active shell callers.
- `mobile-web-source-control-operations.ts` and subscription dispatch: superseded
  status/diff/watch paths; other Source Control operations remain active.
- `mobile-web-native-chat-operations.ts`, `mobile-web-native-chat-subscriptions.ts`
  and `mobile-web-native-chat-message-projection.ts`: superseded domain reads/feed
  and mutations. Native image/clipboard/pending-delivery paths remain needed.
- `mobile-web-session-operations.ts`: superseded agentOptions/create/createAgent
  branches. Snapshot/activate/close/browser/quick-command operations are still
  the current implementation, not optional backward compatibility.

`mobile-web-session-snapshot.ts` still populates browser/native-chat authorities.
Deleting it now would break active consumers. Moving those responsibilities is
additional implementation work; removing old-version tests cannot replace it.
Shared presentation/schema files must stay where the hosted page still imports them.

### 3. Settings and first-release shell features

The hosted Terminal route's "Open device terminal settings" alternative exists
for a shell without pagePreferences. Remove that alternative once pagePreferences
is mandatory. Apply the same review to hosted menu and session settings navigation.

`web-terminal-preferences.ts` has two different kinds of fallback:

- No pagePreferences capability → native-only behavior: obsolete baseline branch.
- No stored page value → inherit existing native preference: useful behavior for
  a user's upgrade from native to hybrid; keep it, including explicit false/empty
  value semantics and read-failure handling.

`src/shared/mobile-web/shell-feature-contract.ts` lists five features, including
host scope, host page-session injection, dispatch guards and opaque page state.
Current implementations can become first-release requirements instead of optional
compatibility branches. Do not remove the underlying protections. Retain a small
future feature-negotiation mechanism for genuinely new native capabilities after
release; no historical emulation is needed now.

Existing native screens and native host-operation modules also serve native build
variants and shared hosted presentation. Their mere presence does not mean an
old-hybrid fallback. `mobile-native-baseline-mode.ts` explicitly supports native
release artifacts and development comparison fixtures. Treat artifact retirement
as a separate decision, not collateral cleanup.

### 4. Keep released native-app and remote-host compatibility

Native clients directly call existing RPCs, demonstrated by:

- `mobile/src/session/native-host-session-tab-operations.ts`: session.tabs.list,
  session.tabs.createTerminal, session.tabs.close and browser.tabCreate.
- `native-host-session-native-chat-operations.ts`: nativeChat.readSession and file
  search/list methods.
- `native-host-session-terminal-operations.ts`: terminal metadata RPCs.

Keep their Desktop methods, accepted inputs, response fields/meaning, existing
mobile authorization and subscriptions. Retain new mobileWeb.* adapters beside
those RPCs; that is the appropriate Desktop compatibility boundary, not duplicate
hybrid client behavior. Do not raise Desktop's minimum compatible mobile version
to enforce a hybrid-only baseline.

SSH/headless runtime compatibility also remains real. A current Desktop can target
an older remote host. Do not globally delete capability checks, transport protocol
negotiation or execution-host fallbacks based on the fact hybrid is unshipped.

This audit traces current native call sites; it is not a released-binary cross-version
certification. A representative released native client against changed Desktop is
still the strongest validation before merge.

### 5. Existing Update Desktop UI needs a precise baseline

`use-mobile-web-package-capability.ts` currently tests
MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY. `use-mobile-web-package-session.ts` maps its
absence to host_update_required and "Update Orca on [host] to continue."
The general ProtocolBlockScreen also has desktop-too-old UI, but the shared native
protocol floor is not a substitute for the hybrid baseline.

Package-serving support alone does not prove the newly required generic operation
set exists. Before removing fallback paths, require one final hybrid-baseline
capability on connection and reuse the existing update-required UI. It should
represent the actual first-release package/forwarding contract, not every future
product method. An optional future host method can remain absent in the catalog
without demanding a new APK or falling back to a removed shell translator.

Keep native manifest verification, bridge range admission, payload ceilings and
resource authorization. These protect real execution and future released shells;
they are not historical fallback machinery.

## Tests and documentation

Remove/replace tests asserting successful fallback for old hybrid shells, missing
baseline host grants, and cached pages from intermediate PR versions. Examples:
`mobile-web-file-host-reads.test.ts`, `mobile-web-host-terminal-actions.test.ts`,
`mobile-web-native-chat-file-client.test.ts`, `mobile-web-session-terminal-creation.test.ts`,
and the explicitly old-shell case in `mobile-web-bridge-roundtrip.test.ts`.
Do not remove entire suites: preserve success, invalid-input, privacy, cancellation,
subscription cleanup, deadline, stale-binding and no-duplicate-mutation cases.

Retain tolerant shell→page parsing and additive evolution tests as future contract
properties. Replace blanket "keep legacy v2/cached pages" requirements in the main
tracker and architecture policy with the actual first-release baseline. Cached
packages and existing production rollback remain; the extra crash-loop drill and
optional resume improvements stay deferred under YAGNI.

## Recommended removal order

1. Establish the hybrid baseline check using existing Update Desktop UI; verify
   released native clients are unaffected.
2. Remove the page-side fallback selection for completed generic slices.
3. Remove now-unreachable shell operation grants/dispatch/projections after an
   import/call-site check. Leave unmigrated domain operations functioning.
4. Simplify mandatory settings/feature branches and revise the relevant tests.
5. Run code gates and ordinary iOS/Android journeys; include native-client RPC
   compatibility checks. Then continue the remaining domain moves directly,
   without adding another historical hybrid path.

## Implementation status

- [x] Require package support plus `mobileWeb.hybrid.v1`; package-only hosts show Update Desktop.
- [x] Remove fallback selection from all completed generic slices in the table.
- [x] Remove 23 superseded shell grants/dispatch operations and dead adapters.
- [x] Remove legacy subscription-client entry points; retain generic subscriptions.
- [x] Require page preferences, opaque page state and paste-followed-by-text baseline.
- [x] Keep inherited native preference defaults and existing native device operations.
- [x] Preserve released-native RPC implementations and protocol minimums unchanged.
- [x] Final code gates, Desktop rebuild, serialized page export and iOS/Android smoke for this batch.

Registry: 230 → 207 operations. Census updates retain operation/schema, echo,
mutation authority, cancellation, bounds and privacy checks on the active paths.
The native RPC surface is unchanged by this batch; released-binary mixed-version
certification remains outside the ordinary hosted emulator fixtures.

Recorded validation: Terminal preference reads are serialized against the
existing four-request bridge ceiling, with regression coverage. Desktop adapters
retain bounded directory/text and Source Control status/diff responses. Native-chat
reads now bound serialized JSON bytes, preserving message identities, pagination
and future fields where possible; oversized content is visibly truncated. Its existing
generic feed reuses that budget for consistent behavior (the feed size limitation
predates this simplification). Native RPC implementations remain unchanged.

All ten code gates pass: 845 mobile files / 5,551 passed / 3 skipped;
334 root files / 2,781 passed / 1 skipped.
Desktop main rebuild and isolated page export pass: 56 assets / 9,762,455 bytes /
2,800,127 gzip; build `d8674fc539d49adb8f9dd043c4f96d462468ecd24f7b008764901e82893bb078`.
iOS full existing adversarial/settings and Android adversarial smoke both exited 0
with `ok: true`; iOS checked exact-build activation. The owned Android emulator
was stopped.

Inspected iOS Chat/Terminal and Android Tasks screenshots. Android settings and a
dedicated rendered native-chat transcript journey remain unverified; headless Review
opening exercises expected error presentation. This is development-shell emulator
coverage, not released-binary mixed-version certification or a physical-device/SSH
journey. Broader session/feed and remaining domain consumers, Voice/notification/
diagnostics/CSP work remain. Optional process-death resume and extra crash-loop
validation are deferred; existing production rollback is unchanged.
