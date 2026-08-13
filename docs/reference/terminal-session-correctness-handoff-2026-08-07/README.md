# Terminal session correctness and authority handoff

> **Status: preserved and paused, not complete, not release-ready.**
>
> The comprehensive program is at **0/8 proven goalposts** and
> **2/13 proven journeys**. No agent may narrow, replace, or mark a goalpost
> complete without the user's explicit approval and the proof named in this
> folder.

This folder is the sole continuation entrypoint for the work previously called
“React 185” or “terminal session authority.” That shorthand is too narrow: the
program covers terminal identity, ownership, exact operations, reconnect,
delivery, migration, daemon and SSH lifecycle, paired and remote runtimes,
cross-platform compatibility, performance, and removal of superseded code.

## Read in this order

1. Read all three preserved source documents with the exact `git show` commands
   under [Repository checkpoint](#repository-checkpoint). The normative design,
   delivery ledger, and original pause handoff are mandatory, not optional
   implementation detail.
2. [`goalposts.md`](./goalposts.md) — the current completion contract, amendable
   only by an explicit user decision.
3. [`related-open-work.md`](./related-open-work.md) — live PR/issue overlap and
   conflicts.
4. [`resume-plan.md`](./resume-plan.md) — safe continuation order and required
   validation receipts.

The older `terminal-session-authority-handoff-2.md` is useful as an adversarial
report, but it is not authoritative. In particular, its “descoped,” “shipped,”
identity-equivalence, timer, and LOC claims must not be copied as settled facts.

## Non-negotiable user objective

Deliver one coherent long-term terminal-session correctness model that:

- removes the root causes instead of leaving quarantine, retry-window,
  sliding-window, optional-metadata repair, or other reconciliation as the
  final correctness mechanism;
- never treats missing, unavailable, timed-out, disconnected, or unknown state
  as proof that a process is dead or that replacement/destruction is safe;
- works for local terminals, daemon, WSL, direct and nested SSH, paired runtime,
  remote server, folder workspaces, floating workspaces, and git worktrees;
- remains correct when clients and hosts update independently;
- works on macOS, Linux at the supported glibc floor, Windows, WSL, and Docker
  OpenSSH;
- has no correctness, security, latency, throughput, memory, restore, startup,
  backpressure, or large-pane regression;
- finishes with **strictly less aggregate production code than the frozen
  pre-program baseline** after all superseded implementations are deleted; and
- is proven through real production paths and discriminating end-to-end
  journeys, not inferred from test counts or green CI.

Correctness and performance cannot be weakened to reach the code-size target.
The code-size target also cannot be waived because a replacement architecture
was added beside the old one.

## Authority and scope rules

- Direct user instructions govern scope.
- The original normative design remains the contract except where a later,
  explicit user decision changes a named requirement.
- This handoff tightens G6 to **strictly net-negative production LOC** because
  the user explicitly asked to end with less production code than the original
  baseline.
- The default frozen accounting baseline is
  `5ed45739e94bdf6460364e033bfcec9b32c0b42a`, the base recorded by GitHub for
  PR #12600. This program subsumes that containment PR. Every later
  program-attributable merged prerequisite and every stack layer must be counted
  in aggregate; rebasing may not roll the accounting baseline forward and hide
  earlier additions. Changing this baseline requires an explicit user decision.
- Focused tests, green CI, a review comment, a behavior-contract document, an
  open PR, or a construction milestone cannot amend the design or promote a
  release goalpost.
- A replacement design is allowed, but it must map every original invariant,
  risk, and journey to an equal or stronger mechanism, close the known liveness
  gap, and receive explicit user approval before the ledger changes.
- Only `not started`, `partial`, and `proven` are valid gate statuses.
  “Descoped,” “superseded,” and “met for what shipped” are not valid statuses
  for G0–G7 under the current objective.
- A narrow incident PR may be independently useful or mergeable. It does not
  reduce the comprehensive denominator of eight goalposts and thirteen
  journeys.

## Settled status

| Scope                      | Status                                        | Meaning                                                                                                                                                         |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction preservation  | **Complete locally; not remotely durable**    | The 814-path construction tree and the original three authority documents are preserved at local branch `nwparker/react185-authority-snapshot` / `fddb19f6977`. |
| Comprehensive goalposts    | **0/8 proven**                                | G0–G4 and G6 are partial. G5 and G7 are not started.                                                                                                            |
| Required journeys          | **2/13 proven**                               | Journeys 1 and 2 have clause-selective discriminating oracles run on every environment they name. The other eleven remain unproven.                             |
| Current branch / PR #13111 | **Implemented, open, unapproved, incomplete** | Useful narrow SSH containment; not a long-term completion and not merged.                                                                                       |
| PR #13110                  | **Open, independent, unapproved**             | Useful preload artifact guard; not shipped and has an unresolved major review thread.                                                                           |
| Less-code gate             | **Failed on current candidate**               | PR #13111 is net positive; the preserved construction snapshot is net `+60,903` production LOC.                                                                 |

The numeric release checkpoint is therefore:

- **G0:** partial
- **G1:** partial
- **G2:** partial
- **G3:** partial
- **G4:** partial
- **G5:** not started
- **G6:** partial and currently failing its final LOC condition
- **G7:** not started
- **Total:** **0/8 proven, 6/8 partial, 2/8 not started**
- **Journeys:** **2/13 proven** (Journey 1 natively on macOS/Linux/Windows; Journey 2 on macOS/Linux/physical WSL)

This is the **program artifact ledger**. Its partial G0, G1, G3, and G4 evidence
exists only in the preserved construction snapshot and historical receipts. It
does not mean those implementations exist on the current #13111 branch. The
current candidate contributes credible partial G2 evidence and limited
compatibility/review evidence, but it proves **zero** complete release gates.

## Repository checkpoint

Verified before creating this documentation folder:

- Worktree:
  `/Users/nwparker/orca/workspaces/orca/eye-React-185`
- Current branch: `nwparker/sta-3077-reattach-pane-cardinality`
- Current HEAD: `5369479be2953f45cea9ab5cfcde756dd9660548`
- HEAD subject: `fix(pty): let liveness say unknown instead of forcing it to say dead`
- Local `origin/main`: `0d29497f8279e2d4c2d26ffc8f3fb68cee2756a7`
- Merge base: `e6e197feeddd1adda066c5cd22f7ee056a12c8c1`
- Distance from local `origin/main`: 15 commits ahead, 19 behind
- The worktree was clean before this handoff. The expected handoff-only changes
  are this folder and its `.gitignore` allow-list entry.
- Preserved construction branch:
  `nwparker/react185-authority-snapshot`
- Preserved construction commit:
  `fddb19f6977ae4ba4764c32afc9fe104c1ed2549`
- Preservation location: local ref only; the branch has no upstream, tag, or
  remote branch containing this commit
- Snapshot status: **unshippable salvage/reference only**

The exact commit ID is the preservation anchor. Do not checkout, switch, reset,
rebase, commit, or push from the snapshot branch in the primary worktree. Read
its authority documents without switching branches:

```bash
git show fddb19f6977:docs/reference/terminal-session-authority.md
git show fddb19f6977:docs/reference/terminal-session-authority-delivery.md
git show fddb19f6977:docs/reference/terminal-session-authority-handoff.md
```

Mine tests, design arguments, or narrow implementations only through `git show`
or a disposable isolated worktree, and only after verifying that they address a
reachable production path on the current base. A local tag protects against
branch movement and ordinary GC only; it does not survive loss of this machine.
Cross-machine/crash preservation requires a copy-verified off-machine bundle or
an explicitly authorized remote ref. Do not infer permission to push it.

## Current narrow candidate: what is real

At current HEAD / PR
[#13111](https://github.com/stablyai/orca/pull/13111):

- SSH relay reattach passes `mayCreate: false` to stop that call site from
  creating durable pane/layout state.
- Duplicate complete pane leases are superseded and excluded from reattach.
- Existing duplicate complete leases are reconciled during reconnect.
- Reattach failure paths require positive evidence before cold respawn.
- PTY inventory can report `unknown` rather than collapsing an unavailable
  provider into `false`/dead.
- Focused tests and GitHub checks are green at HEAD.

These are credible partial G2 improvements. They do **not** establish the
comprehensive design or release gates.

## Current narrow candidate: what remains unproved or wrong

- Lease row identity is still `(targetId, ptyId)`. Pane fields remain optional.
  Active-pane cardinality is enforced by sibling expiration and a healing scan,
  so the end state remains reconciliation-based rather than structurally
  pane-keyed.
- Incomplete legacy leases bypass pane arbitration.
- Superseded remote shells are deliberately left running and unreachable. The
  PR body acknowledges that the “accumulates unused shells” half of the incident
  remains unresolved.
- The repeated-reconnect Docker test still passes with and without the fix: it
  is a forward guard, not causal proof. Its sibling in the same spec — 'leaves a
  lease whose durable pane is gone unbound…' — was reported as discriminating,
  but that DID NOT REPRODUCE on a second machine: with `mayCreate: false`
  removed from the reattach call site and the app rebuilt, both tests still
  passed. Its induction races `pty:kill` against a severed transport, so when
  the kill lands the lease is cleaned up and there is nothing to graft. Treat
  both tests as forward guards. No journey is proven.
- The final Docker settle assertion has an unresolved major review thread: a
  late pane or shell can appear after the polling assertion has already passed.
- The production-call-site wiring oracle reads source text. It does not execute
  the full production reattach path.
- `mayCreate: false` is wired at one production binding call site, not proven
  across every recovery/reattach runtime. `removeSshRemotePtyLease` still has one
  production caller, the spawn-persistence rollback.
- `WEDGED_DAEMON_GRACE_RETRIES = 11` remains reachable and still permits retry
  count to drive daemon replacement after unknown inventory.
- `terminal-input-quarantine.ts` remains reachable.
- No current-tree proof covers physical Windows, WSL, the Linux glibc floor,
  paired runtime, remote server, two independent SSH hosts, live mixed-version
  peers, or production-scale performance.
- There is no candidate-versus-baseline performance result for the new
  per-upsert sibling scan or reconnect healing pass.
- PR #13111 is open, has no approval decision, and is not shipped.

Current HEAD census against its merge base, before this documentation change:

| Category                                            | Additions | Deletions |      Net |
| --------------------------------------------------- | --------: | --------: | -------: |
| Production source, including a fixture under `src/` |       374 |        65 | **+309** |
| Tests and end-to-end tests                          |       944 |        30 |     +914 |
| Documentation                                       |       146 |         0 |     +146 |
| CI/configuration                                    |        43 |         0 |      +43 |
| Total GitHub diff                                   |     1,507 |        95 |   +1,412 |

The production source plus Docker runner is net `+350`. Whichever taxonomy is
used, the categories must remain separate and G6 is not proven.

## Corrections to the previous handoff

- PRs #13110 and #13111 are **open and green**, not shipped.
- #13110 is implementation-independent from #13111, but emitted-preload safety
  remains inside G0/G5/G7 and any retained #13110 production/build logic counts
  in the aggregate G6 census.
- The snapshot genuinely failed to wire `mayCreate`, pane-cardinality
  arbitration, or a complete shell-lifecycle fix into the affected legacy SSH
  path.
- Pane key, PTY ID, incarnation ID, a narrow CAS, and a three-valued daemon
  resolver pre-existed and should be reused where their semantics match.
- Existing `connectionId` and `worktreeId` do **not** establish equivalence to a
  final-host-minted authority identity and canonical host-local namespace.
- The normative design never banned all timers. It permits bounded waits and
  backoff; it forbids elapsed time or retry count **alone** from deciding
  identity, liveness, takeover, replacement, or destruction.
- The design does have a liveness gap: a permanently lost retained consumer can
  hold compaction at capacity without a sufficiently explicit bounded operator
  recovery path. G0 and G3 cannot become proven until that is resolved.
- The claimed approximately 6,500-line comparison implementation has no
  reproducible census and cannot justify deleting requirements.

## Definition of done

The comprehensive work is done only when all of the following are true on one
rebased, converged candidate SHA:

- every G0–G7 section in [`goalposts.md`](./goalposts.md) has its named
  production implementation and current proof;
- all thirteen required journeys pass with their full oracles;
- each new causal oracle is red on the unfixed baseline and green on the final
  candidate; formal verification may supplement but never replace a required
  live journey;
- every open incident bound to the mandatory issue-to-journey matrix in
  [`related-open-work.md`](./related-open-work.md) passes its discriminating
  oracle or is ruled unrelated with explicit evidence and user acceptance;
- correctness, security, wire, migration, platform, packaging, performance,
  restore, and scale reviews have no unresolved P0–P2 findings;
- the aggregate production source census is strictly net-negative against the
  frozen pre-program baseline, including all program-attributable prerequisite
  PRs and stack layers;
- no superseded reconciliation, quarantine, duplicate state machine, legacy
  writer, or test fixture remains reachable in production; and
- the user explicitly accepts any deliberate change to the normative design.

Anything less must be reported as partial, regardless of test count or PR
state.
