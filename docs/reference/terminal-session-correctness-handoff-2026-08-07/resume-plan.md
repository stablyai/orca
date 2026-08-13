# Resume plan and validation record

This plan preserves the comprehensive objective while allowing independently
safe stacks. It does not require reviving the 814-path construction snapshot.

## First safe commands

Run from the primary worktree before editing:

```bash
pwd
git status --short --branch --untracked-files=all
git rev-parse HEAD origin/main
git rev-list --left-right --count HEAD...origin/main
git branch --list 'nwparker/react185-authority-snapshot'
git show --stat --oneline fddb19f6977
gh pr view 13111 --repo stablyai/orca --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefOid,url
```

Expected handoff checkpoint before other changes:

- branch `nwparker/sta-3077-reattach-pane-cardinality`;
- HEAD `5369479be2953f45cea9ab5cfcde756dd9660548`;
- snapshot branch and commit present;
- only this handoff folder and its `.gitignore` allow-list are new handoff work.

If the branch, HEAD, or dirty paths differ, inventory and preserve them before
continuing. Never reset, clean, overwrite, or switch away from unknown user work.

## Phase 0 — Reconcile reality before design or code

1. Refresh `origin/main` with `git fetch origin main`—never `git pull`—and
   refresh the live state/reviews of every PR in
   [`related-open-work.md`](./related-open-work.md) that touches the intended
   slice.
2. Recalculate the candidate merge base, categorized LOC, changed-file overlap,
   and failing/obsolete tests.
3. Freeze the program accounting baseline before implementation. The default is
   `5ed45739e94bdf6460364e033bfcec9b32c0b42a` (the base of #12600). Build an
   aggregate carry-in ledger for every program-attributable PR already merged
   after it; do not measure only the last PR in a stack.
4. Read the final diff of #13111, #12264, and #12743 with `gh pr view` and
   `gh pr diff`, or in disposable isolated worktrees. Never use `gh pr checkout`
   or switch branches in the primary worktree. Select or design one coherent
   lease/reattach model; do not combine mutually inconsistent quarantine, kill,
   and non-kill policies.
5. Reconcile #12882 before overlapping daemon-endpoint integration and #12760
   before overlapping relay-generation cleanup. Neither blocks unrelated SSH
   proof work by declaration.
6. Treat the preserved snapshot as a local-only mine, not a branch to finish.
   Inspect it with `git show fddb19f6977:<path>` or in a disposable isolated
   worktree; never switch the primary worktree to it.

Decision output required before implementation:

- exact incident mechanisms being eliminated;
- exact authority/identity semantics retained or changed;
- explicit remote-shell lifecycle and user recovery behavior;
- explicit lost-consumer liveness/compaction behavior;
- PR/stack boundaries and dependency order;
- production modules expected to be deleted; and
- tests that will discriminate the baseline from the candidate; and
- a predeclared performance protocol with fixed workloads, samples,
  statistical/noise bounds, deterministic counters, and raw-data locations.

## Phase 1 — Build discriminating journeys first

Before relying on a code change, create or repair oracles that reproduce the
failure on an unfixed baseline.

### STA-3077 Docker SSH oracle

The Docker journey must:

- run a real OpenSSH server with `MaxSessions=1` verified from the server;
- create a known pane and record tab, leaf, binding, relay PTY, and remote PID;
- seed or naturally reproduce duplicate/stale lease state from the field;
- exercise disconnect, client restart, reconnect, and authority/relay restart;
- wait an explicit settle interval after successful reattach;
- recensus visible panes, tabs, exact bindings, persisted leases, relay PTYs,
  and actual remote processes/PIDs;
- prove no pane or shell is created, rebound, lost, or silently killed;
- prove explicit unresolved recovery for state that cannot be established; and
- exercise explicit close, lost shutdown response, reconnect retry, and
  worktree teardown; prove exact remote PID/session-slot reclamation while an
  uncertain sibling survives; and
- fail for the intended reason on the unfixed baseline.

A clean reconnect that passes on both revisions is not this oracle.

### Duplicate-agent oracle family

Cover transient SSH loss, `restoreRequired`, sleeping-agent wake, worktree
switch, and closed-tab restart. Assert process count and transcript/session
ownership, not just pane/store state. No path may start a second `--resume`
process while the first process is live or unknown.

### Daemon and remote oracles

Cover unknown inventory, endpoint handover, daemon restart, relay generation
reuse, client sleep/wake, remote-runtime restart, and stale subscription repair.
A retry limit may end an attempt or surface a failure; it may not itself prove a
session dead or authorize destructive replacement.

## Phase 2 — Reconcile and approve the long-term design

The implementation design must explicitly settle:

- final-host identity versus client routing aliases;
- canonical host-local namespace for worktree, folder, floating, drive, and UNC
  forms;
- structural one-active-binding/lease ownership rather than optional metadata
  plus repair scans;
- exact operation fencing across every transport;
- explicit detach, close, retirement, orphan recovery, and process-reclamation
  operations;
- durable outcome/replay semantics across app, renderer, host, and transport
  restarts;
- mixed-version capability and isolated legacy behavior;
- lost-device consumer retirement and compaction liveness;
- one-way migration/cutover; and
- the four-role deletion oracle and minimised, justified production-code target.

Reuse existing pane, PTY, incarnation, CAS, and three-valued liveness primitives
where their semantics match. Do not equate client routing IDs with host identity
or namespace without proving the full semantics.

If the chosen design differs from the preserved normative design, write an
explicit mapping for every invariant and every journey, identify what changes,
show equal or stronger safety/liveness, and obtain the user's approval. A
handoff author or implementation agent cannot approve that scope change alone.

## Phase 3 — Implement as a convergent stack

Stacks are allowed for reviewability. Temporary production stopgaps are not the
end state.

A sensible dependency shape is:

1. discriminating journey harnesses and behavior oracles;
2. final shared identity, liveness, and exact-binding primitives;
3. local/daemon/WSL/SSH/relay/paired/remote adapters using those primitives;
4. durable outcome, projection, reset, and recovery lifecycle;
5. one-way migration and capability cutover;
6. deletion of superseded writers, ledgers, repair scans, timers used as verdicts,
   and duplicate state machines; retain `terminal-input-quarantine.ts` until a
   replacement passes its destructive-input oracle; and
7. full platform, skew, performance, packaging, and independent review proof.

Each stack layer must be safe and tested, but the comprehensive status remains
0/8 until the final integrated candidate satisfies the complete gates. Do not
advertise the authoritative capability or claim program completion mid-stack.

## Phase 4 — Run the complete proof matrix

Use [`goalposts.md`](./goalposts.md) as the checklist. All thirteen production
journeys and every row in the mandatory
[`issue-to-journey matrix`](./related-open-work.md#mandatory-issue-to-journey-matrix)
are required. At minimum the final matrix must include:

- real macOS, Linux floor, Windows, and WSL;
- local, daemon, direct SSH, nested SSH, paired runtime, and remote server;
- one Docker host with `MaxSessions=1` and two simultaneous Docker hosts;
- git worktree, folder, floating, drive, and UNC workspaces;
- old/new peers in both directions at every changed app/daemon, SSH relay,
  paired-runtime, remote-server, and mobile/E2EE boundary;
- app, renderer, daemon, relay, and remote-runtime restart;
- crash cuts around durable operations and identity reset;
- unknown/timeout/disconnect/lost-response/concurrent-replacement cases;
- actual remote PID and process accounting; and
- A/B performance and memory results under the predeclared protocol, including
  raw samples, confidence intervals, deterministic counters, and leak slopes.

## Phase 5 — Delete, census, rebase, and review

1. Trace every new production module from a real entrypoint.
2. Delete unreachable modules and fixtures in production trees.
3. Delete all superseded legacy writers and reconciliation state machines after
   cutover.
4. Rebase onto the actual PR base.
5. Rerun all journeys and static/package checks on the rebased SHA.
6. Report production, tests, docs, CI/runner, generated, and vendored LOC
   separately.
7. Minimise aggregate production source net LOC against the frozen pre-program
   baseline, including all program-attributable carry-in and stack layers, and
   justify every net addition as required by D1.
8. Run an independent repository review and the release-readiness checklist.
9. Resolve every P0–P2 finding.
10. Only then prepare the comprehensive PR and ask the user to approve any
    deliberate design change.

## Validation status at this handoff

This was a documentation and read-only audit turn. No product test command was
rerun, so this handoff claims no fresh local product-test pass.

Exact validation commands run for this handoff:

```bash
git status --short --branch --untracked-files=all
git rev-parse HEAD origin/main
git rev-list --left-right --count HEAD...origin/main
git merge-base HEAD origin/main
git diff --numstat --no-renames "$(git merge-base HEAD origin/main)"..HEAD
gh pr view 13111 --repo stablyai/orca --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefOid,url
handoff_query_text="$(tr '\n' ' ' < docs/reference/terminal-session-correctness-handoff-2026-08-07/github-overlap-query.graphql)"
gh api graphql -f query="$handoff_query_text"
pnpm exec oxfmt --check docs/reference/terminal-session-correctness-handoff-2026-08-07/*.md docs/reference/terminal-session-correctness-handoff-2026-08-07/*.graphql
git diff --check
```

Outcomes:

- repository commands exited 0 and produced the branch/SHA/distance recorded in
  `README.md`;
- the current-HEAD numstat reproduced `+309` production, `+914` tests/E2E,
  `+146` docs, `+43` CI/config, and `+1,412` total net LOC;
- the reproducible GraphQL catalog returned all 65 referenced items and one
  unresolved, non-outdated review thread on each of #13110 and #13111;
- all 30 linked issues appear in the mandatory issue-to-journey matrix and the
  reusable GraphQL query;
- #13111 was open, non-draft, mergeable/clean, with 47 successful and 5 skipped
  checks and no approval decision; and
- formatting and whitespace checks exited 0 after documentation formatting.

Verified in this worktree:

- repository branch, HEAD, merge base, local `origin/main`, branch distance,
  and clean pre-documentation status;
- snapshot branch/commit presence and the 814-path preservation claim;
- current source implementation of the narrow #13111 behavior and gaps;
- current categorized #13111 diff census;
- original G0–G7, thirteen journeys, and PR proof contract; and
- live GitHub PR/issue state through batched GraphQL queries.

Live GitHub verification at the time of writing showed:

- #13111: open, non-draft, mergeable/clean, checks successful, no approval, one
  unresolved major review thread;
- #13110: open, non-draft, checks successful, no approval, one unresolved major
  review thread;
- #12264 and #12743: open competing STA-3077 implementations;
- #12474, #12477, and #12600: merged; and
- the other items in `related-open-work.md`: open unless explicitly labeled
  merged or draft.

These states are ephemeral and must be refreshed.

Historical pause receipts from the 60,903-line construction snapshot remain
construction evidence only. They do not prove the current branch, G0–G7, or any
required journey.

## Stop conditions

Stop and return to the user before:

- narrowing or replacing a named goalpost;
- accepting a correctness/performance tradeoff;
- deciding that remote orphan shells may be killed or leaked permanently;
- changing wire semantics without a compatibility design;
- shipping a positive-production-LOC comprehensive stack;
- merging, closing, commenting on, or force-updating external PRs; or
- deleting preserved user work.

## Short takeover prompt

> Continue the comprehensive terminal-session correctness program from
> [`README.md`](./README.md). Preserve the fixed status of **0/8 proven gates
> and 0/13 proven journeys** until every proof in
> [`goalposts.md`](./goalposts.md) passes on one rebased candidate. Reconcile the
> conflicting open work in [`related-open-work.md`](./related-open-work.md),
> build discriminating real SSH/daemon/paired/remote/cross-platform journeys,
> remove root causes and superseded reconciliation, minimise and justify every
> production-code addition per D1, and finish with no correctness or performance
> regression.
