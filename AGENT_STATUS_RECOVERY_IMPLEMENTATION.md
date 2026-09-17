# C7 host-owned status publication and replica recovery

Result: **INCOMPLETE (failed acceptance)**

The C7 implementation is present and the reconnect-loss defect is fixed, but the complete
acceptance matrix still needs real provider, mixed-version, and consumer evidence. This report is
deliberately not a succeeded-with-gaps claim.

## Revision and scope

- Exact `HEAD`: `acbcaf12a5f2c69e3a811079521f50c3475b84bd` (`fix(agent-status): retain SSH replicas across contact loss`).
- Exact pinned base: `b5a99462bced6871b8a1c711222bc58cff938b9f` (`origin/main` at implementation start).
- Merge base: `b5a99462bced6871b8a1c711222bc58cff938b9f`.
- The branch includes the preceding C7 host-store, publisher, runtime composition, SSH
  negotiation, and reader-cutover commits plus the final reconnect fix.
- Pre-existing `pnpm-lock.yaml`, copied brief/triage/QA artifacts, and `.c7-review-baseline.md`
  remain uncommitted. `.c7-private-precedent.md` is intentionally untracked.

## Failure mechanism and replacement

During a relay reconnect, `wireUpAgentStatusStore` classified transport failures (`CONNECTION_LOST`
and `DISPOSED`) as if the host lacked the status methods. That path called `abandonHost`, erasing
the last host inventory before a replacement snapshot arrived; contact loss was therefore
observable as an empty inventory. The negotiation now has three outcomes (`capable`, `legacy`,
`unavailable`): only an explicit JSON-RPC method-not-found (`-32601`) enters legacy fallback and
abandons stale membership, while transport failures and malformed/wrong-scope responses retain
rows as `unverifiable` and do not install the legacy hook writer. A complete, correctly scoped
snapshot remains the only publication that can replace host membership; explicit abandon remains
the only retirement path.

## Production composition delivered

| Surface | Host-owned path | Judgement |
| --- | --- | --- |
| Desktop main | One hook-server source plus runtime host-replica store; IPC/dashboard and session-tab republish consume composed snapshots. | Implemented in source; Electron visual proof pending. |
| Headless `orcad` | Same hook publisher and replica composition, with status/session-tab republish installed. | Implemented in source; live headless run pending. |
| Relay host | Relay hook cache is adapted to the bounded ordered publisher; owner epoch and cursor are per relay process; subscriptions are cleaned per client. | Focused tests pass. |
| Direct SSH | Snapshot and stream are capability-negotiated; frames are host-scoped and epoch/cursor fenced; gaps/overflow request one coalesced resnapshot; contact loss is retained uncertainty. | Focused fake-transport tests pass; real provider matrix pending. |
| Session tabs / desktop / CLI / dashboard | Shared runtime snapshot and host capability gate feed readers; capable hosts suppress legacy arbitration and reconcile omissions from complete inventory. | Unit coverage exists; rendered consumer matrix pending. |
| Mobile / paired runtime | Runtime RPC/catalog and mobile allowlist expose the negotiated projection. | Source wiring exists; native/mobile proof pending. |

## Acceptance matrix

| Case | Result | Evidence or remaining work |
| --- | --- | --- |
| Complete host snapshot replaces only its host | **PASS** | `agent-status-host-replica-store.test.ts`. |
| Incomplete census retains omitted rows and marks membership unconfirmed | **PASS** | Replica-store test. |
| Cursor gap, overflow, and owner restart retain rows and require resnapshot | **PASS** | Replication/publisher tests and SSH coalescing path. |
| Wrong execution-host frame is rejected | **PASS** | Replica-store test. |
| Contact loss retains waiting/working row as `unverifiable` | **PASS (deterministic)** | Replica-store test and capable relay disconnect test. The previously observed reconnect loss is fixed by the negotiation classification regression test. |
| Authoritative empty complete inventory removes rows | **PASS** | Complete-membership replacement test. |
| Capable relay bypasses legacy `ingestRemote` | **PASS (qualified)** | SSH integration test uses real dispatcher/multiplexer seam but synthetic hook frames. |
| Legacy relay fallback abandons stale replica membership | **PASS (qualified)** | SSH integration test for explicit method absence. |
| Capability negotiation both directions | **PARTIAL** | Current/new and fallback probes are covered; old/new released relay artifacts are not exercised. |
| Duplicate replay preserves receipt clock and state-start time | **PASS** | Replica receipt tests and relay cache tests. |
| Local and remote host isolation | **PASS (deterministic)** | Scoped-host unit test; two live execution hosts are not exercised. |
| SSH reconnect with real remote provider turn | **BLOCKED** | Prior manual QA used a real Linux SSH/relay transport but synthetic hook POSTs; no configured provider CLI was available. |
| Session-tabs omission/removal after host inventory drop | **PARTIAL** | Renderer unit coverage; no live paired-client omission journey. |
| Desktop/sidebar/dashboard rendered row | **PENDING** | Electron QA is coordinator-owned and was not launched in this implementation lane. |
| Headless CLI `worktree ps` parity | **PENDING** | Source composition is wired; no live `orcad` evidence in this lane. |
| Mobile native parity | **PENDING/BLOCKED** | No emulator run; no screenshot evidence. |
| Windows, WSL, macOS, and Linux remote matrix | **BLOCKED** | Only deterministic fixtures and one Linux SSH manual run are available. |

## Functional correctness

**PASS for the fixed mechanism and deterministic C7 contracts.** The last observation survives
transport loss, a complete host inventory is authoritative for that host only, epoch/cursor gaps
cannot silently apply, and only explicit unsupported negotiation or deliberate abandon drops rows.
The regression test locks the critical distinction between `-32601` and transport failures.

**Remaining functional gaps:** no actual provider agent turn over SSH, no released old/new relay
pair, and no live second-host/consumer matrix. These prevent declaring the whole C7 batch complete.

## Architectural fit

**PASS for ownership and delivery boundaries.** The execution host remains the writer; the runtime
holds a scoped mirror; publisher buffering is delivery-only; readers retain presentation policy;
contact is separate from row evidence; no timer, process-presence heuristic, or reader precedence
guard was added. The shared canonical status store/child-work contract from the pinned base remains
the lifecycle authority; this C7 projection carries host status delivery and does not mint a second
run/child registry.

**Material public-safe deviation:** direct SSH probes capability by method presence because relay
  binaries predate the stream. A confirmed method absence downgrades to legacy; a transport or
  malformed response is unknown and retains the replica. This is an explicit compatibility mode,
  not an optional-field assumption.

## Concrete private precedent locations

Mechanism comparisons and verified/unverified deviations are recorded only in the untracked
`.c7-private-precedent.md`. No external project attribution is repeated here or in code.

## Reliability contract and gate

- **Invariant:** `agent-session.provider-ownership` / host-mirror safety — contact loss never
  certifies exit or deletes the last host observation; only complete scoped inventory or explicit
  abandonment changes membership.
- **Failure source:** SSH relay reconnect was observed to clear a remote row before resnapshot.
- **Oracle:** replica host snapshot (`contact`, `membershipConfirmed`, owner epoch/cursor, rows),
  legacy-ingest call count, and complete-snapshot omission behavior.
- **Gate:** `ssh.localhost-terminal-agent-hooks` remains the applicable experimental gate; this
  implementation adds deterministic negotiation/replica checks but does not promote the gate.
- **Diagnostics:** negotiation logs distinguish unsupported method from transport failure; focused
  tests exercise the error codes; relay owner epoch/cursor and bounded buffer markers diagnose gaps.
- **Provider/platform matrix:** local and relay fixtures covered; SSH Linux transport manually
  exercised with synthetic hook evidence; daemon, WSL, Windows, macOS remote, real providers,
  paired runtime, mobile, and dashboard are accepted gaps for follow-up QA.

## Performance and resource budget

No polling loop, retry timer, subprocess, or startup await was added. Publisher subscriber buffers
remain bounded at 256 deltas; resnapshot requests are coalesced per SSH session; cleanup removes
notification listeners and publisher subscriptions on detach/dispose. Deterministic tests cover
buffer overflow, listener cleanup, and receipt-clock dedupe. No throughput or host-contention
benchmark was run.

## Validation performed

- `ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts` on the focused
  C7 suites: **PASS** (63 tests across seven files before the final small negotiation extraction;
  13 SSH integration tests plus the new negotiation regression also pass).
- `ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node`: **PASS**.
- `ORCA_BACKGROUND_LAUNCH=1 pnpm run check:code-quality:changed`: **PASS**, zero new findings.
- `git diff --check`: **PASS**.
- Electron, mobile emulator, and headless live QA were intentionally not run in this implementation
  lane; no visual or native screenshot claim is made.

## Remaining work / handoff

Coordinator should rerun the real SSH reconnect scenario that originally observed row loss, then
exercise old/new relay negotiation, a second execution host, complete omission after reconnect,
session-tabs/desktop/CLI/mobile/dashboard consumers, and at least one real provider turn. Until
those are evidenced, C7 remains failed rather than complete.
