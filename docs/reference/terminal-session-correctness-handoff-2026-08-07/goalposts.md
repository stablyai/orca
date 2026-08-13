# Goalposts and proof contract

This file answers one question: **what exact evidence is required before an
agent may write “proven”?**

The current status is **0/8 proven goalposts** and **2/13 proven
journeys**. Status may change only from evidence produced on the same rebased,
converged release candidate. Historical snapshot tests and independently useful
narrow PRs may be cited as partial evidence but cannot promote a row.

## Recorded user decisions

These amend the contract above. Only the user may add to this list.

### D1 — G6 relaxed from strictly net-negative (2026-08-07)

> "It's okay if we must increase LOC but try not to."

G6's pass condition is no longer a strict inequality against the frozen
baseline. It is now: **minimise added production code, and justify every net
addition against the correctness it buys.** A net-positive total does not fail
G6 on its own; an unjustified one does.

Why this was needed: the deletion budget the plan assumed does not exist. An
entrypoint-rooted import graph over all 20 real build entrypoints found that
51 of the 53 candidate files in `src/relay/*pty-source-*`,
`src/shared/pty-consumer-*`, and `src/main/ipc/ssh-pty-*` are reachable and
value-instantiated on live paths. Only 2 files (263 LOC) are unreachable, and 2
of the candidates did not exist at the baseline so deleting them earns no
credit. Against roughly +1,021 LOC to offset, a strict inequality was not
reachable without deleting load-bearing code — which the governing rule forbids.

Still binding: correctness may not be weakened to reduce line count, and a
replacement architecture added beside the old one does not earn its lines.

## Proven journeys

### Journey evidence not yet sufficient to promote

**Journey 2 (daemon half).** `tests/e2e/daemon-restart-session-liveness.spec.ts`,
3 tests. Two mutations each redden exactly one clause, on macOS and Linux:
reverting three-valued `hasPty` reddens only the unknown-not-dead clause;
widening the sole-provider fallback reddens only the stale-generation clause.
The lead re-verified the first mutation independently. **Missing: physical WSL**,
which the journey names explicitly. That host is now unblocked (the distro has a
provisioned default user) and the run is outstanding.

**Journey 12.** `tests/e2e/cross-version-wire/`, 13 tests against a real published
baseline. Reverting the restore-required publication to expiry reddens 7 of 13;
restore greens. Lead-verified. **Missing: live skew.** These are in-process wire
tests. The original ledger named live paired-runtime and SSH skew as the gap, and
an in-process decoder test does not close it.

**Journey 4.** Sibling-pane isolation on one host reddens when
`mux.dispose('connection_lost')` is restored. **The cross-host clause cannot be
proven by mutation**: a mux belongs to one relay session per SSH target, so its
dispose cannot cross a host boundary — the cross-host test stayed green under the
mutation, which is the empirical receipt. That clause rests on
isolation-by-construction, and saying otherwise would be a false claim.

**Journey 6.** `tests/e2e/ssh-maxsessions-remote-pid-binding-identity.spec.ts`,
4 tests against a real Docker OpenSSH container configured `MaxSessions 1`, the
cap read back from `sshd -T` inside each test. Three of the four clauses
discriminate, clause-selectively, in single runs (the spec is not `serial`, so a
red test never reports the others as "did not run"):

- dropping `mayCreate: false` from the reattach binding write reddens only the
  authority-reconnect test, with the unowned leaf grafted into the `local`
  partition;
- marking leases `terminated` instead of `detached` in `beginShutdownDetach`
  reddens only the two restart tests, with a cold-spawned shell beside the
  surviving one.

**Missing: the transport-disconnect clause does not discriminate.** Four guard
removals were tried and it stayed green under all of them, including publishing
`SSH_SESSION_EXPIRED` in place of `SSH_SOURCE_RESTORE_REQUIRED` and making
`isProvenSshSessionGoneError` return true for every error. A sever that leaves
the detached relay holding its delivery record reattaches through the checkpoint
path, so no reattach failure is ever classified and the respawn-requires-proof
guards are off that path. Inducing `restoreRequired` needs a lost or mismatched
delivery record, which this fault does not produce. That clause is therefore a
forward guard and cannot promote the row. Also missing: only Docker-on-macOS was
run; the explicit-close/proven-teardown retirement clause is not covered.

**Journey 13.** Not proven. One of ten named dimensions measured. The
`isSupersededPtyId` fence costs roughly 14ns per call, but it was measured on
lifted predicates in plain Node, not through real Electron IPC — that part is an
inference, not a measurement.

### Correction: Journey 12's cross-version tests exercise a route production does not have

Recorded earlier that the cross-version suite "confirms the new
`SSH_SOURCE_RESTORE_REQUIRED` token mutates nothing on an old client." That
claim is withdrawn.

An attempt to build a LIVE two-process skew oracle established that the token
never crosses a version boundary at all. It is minted in main
(`src/main/providers/ssh-pty-provider.ts:110`) and consumed in the same app's
renderer (`pty-connection.ts:8833`, `:9080`) over Electron IPC — always one
version. The only cross-version terminal boundary, paired client to HUB runtime,
goes through `remote-runtime-pty-transport.ts`, whose sole respawn trigger is
`SSH_SESSION_EXPIRED` (line 1481), and whose reattach never reaches
`SshPtyProvider.spawn`.

The in-process suite injects the token into `terminal.resolvePane`, which is a
pure lookup and not a route production takes. So those 13 tests are a decoder
guard, not evidence about old clients.

Two consequences, both good: the wire-compatibility risk this branch was thought
to introduce **does not exist**, because there is no version boundary for the new
token to cross. And Journey 12 needs a different oracle entirely — one aimed at a
boundary that is genuinely cross-version.

### Journey 6 — evidence, and why it is not promotable

`tests/e2e/ssh-maxsessions-remote-pid-binding-identity.spec.ts`, 4 tests, each
with its own container and Electron profile, against real OpenSSH with
`MaxSessions 1` read back from `sshd -T` rather than assumed. Remote pids are
read on the container two independent ways and must agree, each carrying its
kernel start time.

Two mutations discriminate and are disjoint: removing `mayCreate: false` reddens
only the reconnect clause; marking leases `terminated` instead of `detached` at
quit reddens only the two restart clauses.

**Not promotable:** the "same remote PID and exact binding survive a transport
disconnect" clause is a forward guard. Four separate guard removals left it
green. It asserts a real property, but nothing shipped is load-bearing for it,
so it cannot be claimed as proof of this branch's work.

### Journey 3 — evidence, and why it is not promotable

`tests/e2e/ssh-lazy-discovery-skipped-host-restart.spec.ts`, 3 tests, two real
containers, sampling sshd's own accept log and live session census 20+ times over
22 seconds with the in-use host as a positive control.

**Not promotable:** no mutation reddens clause 3 alone. The genuine cross-host
lease-scoping guard is load-bearing, but removing it breaks the sibling host
during setup, so the failure carries no clause information.

### Journey 2 — Daemon and physical WSL (proven 2026-08-08)

Oracle: `tests/e2e/daemon-restart-session-liveness.spec.ts`, 3 tests, plus
`tests/e2e/helpers/daemon-shell-process-identity.ts`. The PTY leader is a real
login shell that reports `$$` back through the production write path
(`DaemonPtyRouter.write` -> daemon socket -> PTY), and that pid is resolved to a
kernel start time, so a look-alike respawn cannot pass as a survivor.

It replaced a spec that never crossed the daemon boundary and whose successor
generation owned nothing, which made "the live successor is neither killed nor
replaced" vacuous.

| Environment                                  | Result   | Discrimination watched                              |
| -------------------------------------------- | -------- | --------------------------------------------------- |
| macOS 26.3.1 arm64                           | 3 passed | 2 mutations, each reddening one clause              |
| Ubuntu 24.04 x86_64 native                   | 3 passed | same 2 mutations, same single-clause reds           |
| WSL2 Ubuntu 26.04 on a physical Windows host | 3 passed | reverting three-valued `hasPty` reddens test 1 only |

Clause-selective on all three. The spec runs `mode: 'serial'`, so a red test 1
reports 2 and 3 as "did not run" rather than passing — selectivity was therefore
established by re-running 2 and 3 _alone under the same mutation_ and watching
them stay green, not by assuming it.

Mutation A (`hasPty` reverted to `activeSessionIds.has(id)`) reddens only the
unknown-not-dead clause. Mutation B (widening the sole-provider fallback in
`daemon-session-owner-resolution.ts`) reddens only the stale-generation clause.
The lead independently reproduced Mutation A on macOS.

Also confirmed on the WSL host, independently of the spec: an Orca WSL-mode
terminal now starts and returns real output. It could not start before — the
distro had no provisioned default Unix user, so every interactive `wsl.exe`
launch blocked on first-run provisioning.

Limits, stated rather than implied:

- The WSL run used `ELECTRON_RUN_AS_NODE=1`, which is what this oracle needs
  (real daemon processes and real PTYs, no renderer). It does **not** show that
  Electron's GUI starts under WSL; no display server was started and that
  remains an open question for any journey needing a window.
- WSL evidence is against `d74f5ed0eae` and on Node 22 rather than the required 24. The other two platforms ran the same oracle on Node 24.
- `src/main/providers` is red on that distro for an unrelated reason:
  `local-pty-shell-ready.test.ts` pins an exact OSC 133 marker count and saw 7
  splits where it expects 4. The WSL run attributed that to bash 5.3.9, but that
  is **not** the cause — macOS runs the same bash 5.3.9 and the spec passes there
  67/67. The trigger is environmental to that distro, most plausibly a
  system-wide bashrc contributing prompt hooks, and the underlying defect is that
  the spec asserts an absolute count of markers it does not own. Outside this
  journey's surface, so left for its owner rather than reinterpreted blind — but
  it means "the unit suites are green on WSL" would be false.

### Journey 1 — Local macOS, Linux, and Windows (proven 2026-08-08)

Oracle: `tests/e2e/local-terminal-restart-binding-identity.spec.ts`. Two tests —
the same pane, full binding and OS shell process survive renderer reload and app
restart; and a stale pre-spawn session write is rejected instead of retiring the
live binding.

Process identity is proved by the shell reporting its own pid through the
production write path, plus the kernel-reported start time, so a recycled pid
cannot pass as a survivor.

| Platform                    | Result   | Discrimination watched                                                                                                                                          |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 26.3.1 arm64          | 2 passed | mutation reddens; restore greens                                                                                                                                |
| Ubuntu 24.04 x86_64, native | 2 passed | 4 cycles, incl. deleting `restorableBindings` reconciliation — reddens test 2 only                                                                              |
| Windows 11 26200, native    | 2 passed | A: forcing `shutdownDaemon()` in will-quit reddens test 1 (pid 13756 -> 8852, start times 5.4s apart). B: disabling the same reconciliation reddens test 2 only |

Every run used an isolated TMPDIR, because the harness keys its seeded-repo
pointer on a machine-global tmpdir path and concurrent runs can both fabricate
and mask a red.

Selectivity holds on two platforms: mutation B reddens only the stale-operation
test and leaves the restart test green, so the two clauses are independently
proved rather than jointly.

Residual limit, stated: "every stale exact operation" is proved for the
pre-spawn session-write class. Local `pty:write`/`resize`/`signal` are fenced by
`isSupersededPtyId` with its own oracle, but that fence compares a binding, not
an incarnation — see `binding-identity-design.md`.

## Universal proof rule

A gate is `proven` only when both exist:

1. the complete behavior is reachable through every named production path; and
2. the named proof exercises that behavior and its failure boundaries on the
   final candidate.

Every proof receipt must record:

- candidate commit SHA and exact merge base;
- unfixed baseline SHA used for red/green discrimination;
- exact command or manual journey protocol;
- OS, architecture, filesystem, runtime, Git, SSH, daemon, relay, client, and
  host versions relevant to that journey;
- UTC start/end time, exit status, counts, and artifact/log location;
- the production caller, persistence boundary, transport, and cleanup path
  exercised;
- the expected oracle and the observed result; and
- independent reviewer identity and unresolved-finding count.

For a new regression oracle, demonstrate that it fails for the intended reason
on the unfixed baseline and passes on the candidate. A test that passes both is
a forward guard and cannot prove the fix.

## G0 — One design contract

**Current status: partial.**

G0 is proven only when:

- every reachable production path follows one reconciled identity, host
  boundary, operations, delivery, migration, compatibility, and minimal-shape
  contract;
- there is one final-host authority service, thin transport adapters, one app
  projection/controller, and one bounded pre-cutover legacy importer;
- no adapter or renderer owns a parallel authority state machine;
- all retained existing primitives are mapped by semantics, not similar names;
- the lost-consumer/compaction liveness gap has a safe, bounded, authenticated,
  operator-reachable resolution that does not infer death from time; and
- an independent production-graph audit finds no contradictory path.

The design document alone, a behavior contract, or focused tests do not prove
G0.

## G1 — One final-host authority

**Current status: partial.**

G1 is proven only when local, daemon, WSL, direct SSH, nested SSH, paired
runtime, and remote server all resolve:

- a stable identity minted or validated by the final PTY-owning host;
- a canonical host-local namespace for worktree, folder, and floating
  workspaces;
- one exact pane-generation/PTY-incarnation binding;
- host connections keyed by final-host identity with lazy discovery;
- concurrent host isolation; and
- namespace-local admission, failure, grant, handover, and retirement.

`connectionId`, SSH target ID, client repository ID, path spelling, or
`worktreeId` may be routing metadata. Their existing names and usage counts are
not proof that they satisfy final-host identity or namespace semantics.

Proof requires the applicable live journeys below, including simultaneous hosts
and independent client/host updates.

## G2 — Exact operations only

**Current status: partial.**

G2 is proven only when input, resize, signal, close, output, and exit are fenced
by the full binding captured before any await:

- authority host;
- namespace;
- pane generation;
- owner/writer incarnation;
- physical PTY;
- PTY incarnation; and
- negotiated operation/source generation where applicable.

Stale, partial, absent, timed-out, disconnected, or unknown evidence must not
affect a successor. An authoritative operation must never retry through an
ID-only provider call or a legacy mutation path.

Proof must cover all operations across local, daemon, WSL, SSH, paired runtime,
remote server, renderer fallback, restart, concurrent replacement, and both
mixed-version directions. Store-row counts and source-text assertions are not
sufficient.

## G3 — Durable ordered delivery

**Current status: partial.**

G3 is proven only when the final production design provides all observable
properties below, even if its internal mechanism differs from the preserved
construction design:

- complete boundary snapshot before later events;
- producer held while boundary/replay is established;
- contiguous replay before reconciliation and live resume;
- durable semantic outcomes, including exit and state needed by a newly
  attached consumer;
- durable idempotent main-process projection before acknowledgement;
- final-host-owned cumulative acknowledgement or an explicitly approved
  equivalent with the same crash/replay guarantees;
- renderer snapshot-plus-delta observation;
- app, renderer, host, and transport restart resume;
- gap detection and resnapshot without silent omission;
- bounded memory, queues, pages, listeners, timers, and retained output;
- independent consumer retirement and safe compaction liveness; and
- no app-side duplicate cursor, settlement, receipt, or suffix-reconciliation
  authority.

Proof must include crash-before/after-ACK cuts, lost responses, disconnected
replay, gap recovery, slow/stalled consumers, retired and permanently lost
consumers, paired/remote restart, mixed versions, and scale.

## G4 — One-way legacy cutover

**Current status: partial.**

G4 is proven only when each namespace performs, in order:

1. explicit capability negotiation;
2. a brief legacy-write freeze;
3. exact non-mutating inventory;
4. a deterministic import plan;
5. validation with ambiguity kept visible and non-destructive;
6. one self-contained durable authority commit;
7. topology attachment; and
8. exact client opening through the authoritative path.

There must be no dual writer, destructive inference, authority-to-legacy
fallback, or second durable migration catalog after cutover. Old peers remain
on an unchanged isolated legacy surface or fail before mutation.

Proof requires crash cuts at every phase, replay from the self-contained commit,
ambiguous-row isolation, independent namespace failure, and legacy-writer and
reconciliation deletion.

## G5 — Wire and platform compatibility

**Current status: not started.**

G5 is proven only when all exchanged changes follow the remote-wire
compatibility contract and the final candidate passes:

- old client to new host;
- new client to old host;
- native macOS;
- native Linux at Ubuntu 20.04 / glibc 2.31 compatibility floor;
- native Windows;
- physical WSL, including Git Bash/`.cmd` boundaries where relevant;
- Docker OpenSSH;
- daemon;
- direct and nested SSH;
- paired runtime;
- remote server;
- git worktree;
- folder workspace;
- floating workspace; and
- drive-letter and UNC namespace paths.

Run both skew directions independently across every changed deployment boundary:
app↔daemon, app↔SSH relay/final host, paired client↔paired runtime, remote
client↔remote server, and mobile/E2EE RPC where affected. A single in-process
codec test or one client/host pairing cannot stand in for this matrix.

New opcodes or semantics require explicit capability negotiation. An optional
field that parses on an old peer does not by itself prove that old behavior
remains correct.

Mocking `process.platform`, running Linux inside Docker, or passing in-process
wire unit tests does not prove the corresponding native or live-skew row.

## G6 — Simpler, minimised production code

**Current status: partial; structural clauses remain open.**

Decision D1 replaces the original strict inequality: the final integrated
program must minimise production source and justify every net addition against
the correctness it buys.

The default baseline is
`5ed45739e94bdf6460364e033bfcec9b32c0b42a`, the base recorded by GitHub for
PR #12600. This broader program subsumes #12600. Changing the baseline requires
an explicit user decision recorded before more implementation begins.

G6 is proven only when:

- aggregate program-attributable production source net LOC is **minimised and
  every net addition justified** against the frozen baseline — see decision D1
  under "Recorded user decisions", which replaced the original strict
  inequality once the assumed deletion budget was shown not to exist;
- every program-attributable prerequisite merged after the baseline and every
  stacked PR is included, even if a later rebase places it in `main`;
- overlapping changes are recomputed from the frozen baseline to the final tree
  so additions and later deletions are not double-counted;
- unrelated upstream or user deletions cannot offset program additions;
- production, test, documentation, CI/runner, generated, and vendored changes
  are reported separately;
- every new production module is reachable from a real entrypoint;
- no test fixture remains under production compilation;
- there is one identity comparison, transition implementation, exact-operation
  client, mutation admission path, and delivery state machine;
- no re-export shim or one-type module exists solely to preserve construction
  layering;
- no superseded quarantine, sliding-window, retry-verdict, reconciliation,
  duplicate cursor, receipt ledger, legacy writer, or migration bridge remains
  reachable after cutover; and
- an independent reachability and duplicate-state-machine audit is clean.

Tests or docs cannot offset positive production LOC. A smaller narrow PR is not
proof if the final stack remains net positive. Deleting correctness or platform
coverage to hit the number is prohibited.

Classify by behavior, not directory name: shipped runtime code, migration code,
and build-time code that enforces a shipped artifact invariant are production;
test-only runners and fixtures are tests even when misplaced, and their presence
under production compilation independently fails this gate. Publish the final
file-by-file classification so the count cannot be moved between buckets.

### G6 clause assessment (2026-08-08)

Checked against the current branch rather than assumed:

| Clause                                                                                                                                                      | State                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| aggregate net production LOC minimised and justified (D1)                                                                                                   | +228, each addition justified in its commit; 201 LOC deleted after verifying unreachability from all 20 build entrypoints                                                     |
| every new production module reachable from a real entrypoint                                                                                                | holds — no new unreachable module was added                                                                                                                                   |
| no test fixture under production compilation                                                                                                                | not audited on this branch                                                                                                                                                    |
| one identity comparison / transition / exact-op client / admission path / delivery state machine                                                            | **fails** — several remain, and this is the clause the rejected binding proposal would have made worse by adding a second identity comparison beside `resolveStablePaneOwner` |
| no re-export shim or one-type module for layering                                                                                                           | holds for this branch's additions                                                                                                                                             |
| **no superseded quarantine, sliding-window, retry-verdict, reconciliation, duplicate cursor, receipt ledger, legacy writer, or migration bridge reachable** | **fails** — `terminal-input-quarantine.ts` is imported by `pty-connection.ts:98` and `terminal-pane-recovery.ts:6`                                                            |
| independent reachability and duplicate-state-machine audit clean                                                                                            | not run                                                                                                                                                                       |

On the quarantine specifically: it is **not** subsumed by the superseded-PTY
fence, and claiming otherwise would be wrong. The fence refuses writes aimed at
a stale ptyId. The quarantine guards the user's _subsequent_ typing — the tail
of a half-typed line — landing on the successor shell under its current and
correct ptyId, which the fence never sees.

Deleting it therefore requires contract property B: a _different_ shell surfaces
unresolved and never silently receives the pane, at which point there is no
mangled tail to suppress. That is a behaviour change to the recovery path, not a
deletion, and an earlier attempt to shortcut it was rejected for reintroducing
the `echo hi; rm -rf x` hazard by disarming per-pane state that is keyed per-tab.

G6 is therefore not promotable, and its blocking clauses are structural rather
than arithmetic.

### The input quarantine is load-bearing, not superseded (2026-08-08)

G6's clause lists "no superseded quarantine ... remains reachable" and
`terminal-input-quarantine.ts` was assumed to be one. It is not, and the
evidence is direct.

**The hazard is live.** Disabling the single call site in `pty-connection.ts`
and running the pane's own oracle reproduces it verbatim, lead-verified:

    AssertionError: expected "vi.fn()" to not be called with arguments:
      [ 'cho hi; rm -rf x' ]

Deleting the module without a replacement re-opens `rm -rf` execution.

**Contract property B was costed by building it, not estimated.** Threading the
incarnation to the renderer compiles at **+26 production LOC**, and completing it
(publishing an incarnation from `resolveTerminalPane`, plus a new exported reader
for the module-private `ptyIncarnationById` map) is about **+33**. The
cross-remount state the comparison needs must outlive the destroyed pane, so it
becomes a module of roughly the size of the one being deleted — the two in-tree
precedents are 88 and 86 lines. Adding a renderer-side identity comparison would
also worsen G6's already-failing "one identity comparison" clause. Floor: about
**+140 production LOC to delete 88**.

**And the route is not uniformly available.** `RuntimeTerminalCreate` and
`RuntimeTerminalResolvePane` carry no `incarnationId`; remote connect results are
built without one; and the transport latches `resolvePaneUnavailable` when a host
answers `method_not_found`. Mixed client/host versions are the normal state, and
an optional field does not make an old host publish it. So a paired client reads
_unknown_ — which under this program's own governing rule is not proof of "same
shell". Requiring proof makes every remote reattach surface unresolved; not
requiring it needs a fallback, and the only correct fallback is this quarantine.
Either way the module stays reachable.

`endpointReplaced` is also routine rather than rare — a daemon death remounts
every live pane — so property B would convert each into a manual per-pane
reconnect, which is the coverage deletion G6 explicitly prohibits.

**Consequence:** this clause of G6 cannot be closed by deletion. Either the
clause is amended to recognise the module as load-bearing, or the program accepts
a net-positive change to replace it with something weaker on remote hosts. That
is a user decision (call it D5), not one to assume.

### G6 clause: test fixtures under production compilation (audited 2026-08-08)

Audited by importer rather than filename, then checked against what the build
actually emits. **The clause is already satisfied on the meaning that matters,
and cannot be closed by moving files on the other meaning.**

36 candidates; 4 have genuine production importers and are correctly placed. The
other 32 (~3,300 LOC) have zero non-test importers.

**They do not ship.** Spot-checked the emitted bundle for
`terminal-restore-parity`, `ipcEventsTestHarness`, `storeTestHelpers` and
`sshRelayNativeDepsInstallFixture`: none appears in `out/`. Rollup drops them
because no production entrypoint reaches them. Under "compiles into the shipped
product", this clause holds today.

**Moving them would close nothing under the other reading.**
`config/tsconfig.node.json` and `config/tsconfig.tc.web.json` declare `include`
globs such as `../src/main/**/*` with **no `exclude` at all**. A `__tests__/`
directory is matched by that glob exactly as any other path is, and so is every
`*.test.ts` file in the repo. Relocating 32 fixtures would not remove one file
from typecheck scope.

A sweep was started and stopped once this was verified, rather than landing 32
moves across areas this program does not own for no measurable gain.

If the intent behind the clause is that typecheck scope should exclude test code,
that is a repo-wide tsconfig change affecting every test file — different work
with a different owner, and it should be stated as such rather than pursued by
relocating fixtures.

One genuine defect was found and fixed while auditing:
`terminal-pane/xterm-bypass-event-fixture.ts` and
`terminal-pane/__fixtures__/xterm-bypass-event.ts` were byte-identical apart from
an import path, and the `__fixtures__` copy had zero importers — a half-finished
move left in place. The dead copy is deleted and the live one completed its move.

## G7 — No regression and reviewable comprehensive change

**Current status: not started.**

G7 is proven only on the rebased, converged candidate after G0–G6 and all
thirteen journeys are proven. It requires:

- correctness and security gates;
- A/B input latency and output throughput;
- backpressure and bounded-memory results;
- renderer/app/daemon/relay restore and startup results;
- large-pane, long-session, and multi-host scale results;
- native packaging/startup on macOS, Linux, and Windows;
- WSL, Docker SSH, paired, remote, folder, floating, worktree, drive, and UNC
  coverage;
- both live mixed-version directions;
- final categorized LOC census;
- independent repository review with no unresolved P0–P2 findings;
- release-readiness review with no unresolved correctness, security,
  compatibility, or performance findings; and
- a detailed comprehensive PR whose claims match the receipts.

Before implementation, record a performance protocol that makes “no
regression” falsifiable:

- fixed candidate and baseline builds, hardware, OS, power mode, network shape,
  pane/session population, payloads, and background-load policy;
- warm-up policy, randomized A/B order, sample count, raw-data location, and
  statistical method;
- input latency, output throughput, memory, backpressure, restore, startup, and
  large-pane metrics with directionality;
- deterministic ceilings for writes, scans, queues, listeners, timers, and
  allocations on hot paths; and
- a predeclared equivalence/no-regression bound no larger than measured baseline
  noise. A nonzero bound handles measurement noise; it is not permission for a
  known slowdown and requires explicit user approval.

Unless an independently reviewed protocol justifies another count, use at least
five warm-up trials and thirty measured trials per latency/startup/restore
configuration, retain raw samples, and report confidence intervals. Throughput,
backpressure, and memory tests must also include a fixed-duration steady-state
run and a leak-slope result. Choose all workloads and thresholds before looking
at candidate results.

Green CI, thousands of tests, mergeability, or “reviewable for what shipped” do
not prove G7.

## Thirteen required production journeys

Every row is currently **not proven**.

The issue-to-journey matrix in
[`related-open-work.md`](./related-open-work.md#mandatory-issue-to-journey-matrix)
is part of these journeys, not optional context. Every bound incident needs a
red-on-baseline/green-on-candidate oracle, or explicit evidence plus user
acceptance that it is unrelated.

|   # | Journey                                               | Required oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --: | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Local macOS, Linux, and Windows                       | The same pane, full binding, and OS process survive renderer and app restart; every stale exact operation is rejected. Run natively on all three OSes.                                                                                                                                                                                                                                                                                                                 |
|   2 | Daemon and physical WSL                               | The same PTY survives client and daemon reconnect/restart boundaries; generation skew fails closed without killing or replacing a live successor.                                                                                                                                                                                                                                                                                                                      |
|   3 | Lazy discovery and skipped-host restart               | An unused host is not probed eagerly. After a restart that skipped it, lazy rediscovery restores only that host's sessions and never adopts host-current or sibling-host state.                                                                                                                                                                                                                                                                                        |
|   4 | Concurrent multi-host connections                     | At least two distinct final-host connections operate simultaneously. One host's disconnect, CAS, timeout, or failure cannot affect the other.                                                                                                                                                                                                                                                                                                                          |
|   5 | Namespace-partial admission failure                   | One namespace on a multiplexed connection fails challenge/CAS/grant publication while another commits. Only the failed host-plus-namespace is fenced.                                                                                                                                                                                                                                                                                                                  |
|   6 | Docker OpenSSH with `MaxSessions=1`                   | The same remote PID and exact binding survive disconnect and client restart. Authority restart imports exactly or exposes unresolved recovery without creating, killing, or adopting. Explicit close or exact proven teardown durably retires the lease and process; unknown ownership stays visible and recoverable rather than being killed. Count actual remote processes, panes, tabs, bindings, leases, and session-cap slots before and after a settle interval. |
|   7 | Two independent Docker SSH hosts                      | Two simultaneous final hosts keep endpoint credentials, principals, namespaces, sessions, cursors, failures, and cleanup completely isolated.                                                                                                                                                                                                                                                                                                                          |
|   8 | Paired client and remote server                       | The final host remains authoritative across independently updated peers, pairing reconnect, client restart, and remote-runtime restart.                                                                                                                                                                                                                                                                                                                                |
|   9 | Worktree, folder, floating, drive, and UNC namespaces | Each resolves the same stable host-local namespace across spelling/restart changes, without using client repository ID or target ID as identity.                                                                                                                                                                                                                                                                                                                       |
|  10 | Stable proof and exact retry                          | One bounded device proof identity admits fresh process/session nonces. A lost response retries the exact challenge/request; changed, replayed, cross-host, cross-namespace, or host-current state is rejected.                                                                                                                                                                                                                                                         |
|  11 | Identity reset and re-enrollment                      | Crash-resumable host retirement, relay revoke acknowledgement, transport closure, local credential removal, and atomic successor publication occur in order. Offline and old peers remain explicitly pending.                                                                                                                                                                                                                                                          |
|  12 | Mixed versions in both directions                     | No unknown opcode or ungranted publication mutates state. Unsupported challenge, grant, delivery, or operation semantics stay on isolated legacy behavior or fail before mutation.                                                                                                                                                                                                                                                                                     |
|  13 | Performance and scale                                 | Under the predeclared protocol above, input/output latency, throughput, backpressure, memory, reconnect/restore, startup, large-pane, long-session, and multi-host ceilings show no regression against the fixed baseline. Raw samples, confidence intervals, deterministic counters, and leak slopes satisfy their predeclared bounds.                                                                                                                                |

## Cross-cutting correctness cases

Every relevant journey must exercise:

- stale, missing, unknown, rejected, timed-out, and disconnected evidence;
- concurrent replacement and sibling-host/namespace isolation;
- lost request and lost response;
- cancellation and partial setup cleanup;
- crash immediately before and after every durable boundary;
- restart from disk rather than process-memory state;
- duplicate and out-of-order delivery;
- gaps, overflow, and slow/stalled consumers;
- explicit close versus detach;
- eventual exact retirement after explicit close or proven teardown while
  uncertain ownership remains intact and visible;
- legacy data with missing optional fields;
- relay/daemon incarnation reuse;
- sleep/resume and clock movement where timers schedule retries;
- exact remote process/PID census, not only persisted-row state; and
- cleanup that requires positive identity proof.

## Forbidden proof substitutions

- A mock is not a native-platform journey.
- A source grep is not a production call-path journey.
- A row marked `expired` is not proof that its remote process exited.
- Optional pane metadata plus an O(n) repair scan is not structural uniqueness.
- An empty list from an unavailable provider is not proof of absence.
- A timer or retry budget is not proof of death.
- A broad test count is not a correctness oracle.
- A test that passes unfixed code is not evidence that a change fixed the bug.
- An open or green PR is not shipped behavior.
- Historical construction receipts are not proof for a rebased candidate.
- Prior art or an uncited LOC comparison cannot delete a requirement.

## Promotion template

Before changing any row to `proven`, add a receipt containing:

```text
Gate or journey:
Candidate SHA:
Merge-base SHA:
Unfixed/red SHA:
Production path exercised:
Exact command or manual protocol:
Environment and versions:
Expected oracle:
Red result:
Green result:
UTC start/end:
Artifact/log:
Independent reviewer:
Unresolved P0/P1/P2:
LOC/performance impact:
```

If any field is missing, the row remains partial or not started.
