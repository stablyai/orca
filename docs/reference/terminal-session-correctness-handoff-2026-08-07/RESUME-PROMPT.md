# Resume prompt — terminal session ownership

Paste the block below into a fresh session. Everything it needs is in the repo.

---

You are taking over an in-flight implementation in this repo. Read these, in
order, before doing anything:

1. `docs/reference/terminal-session-correctness-handoff-2026-08-07/new-design-goalposts.md`
   — the tracked goalposts. This is the contract. Report progress against it.
2. `docs/reference/terminal-session-correctness-handoff-2026-08-07/design-explained.html`
   — the design in plain English (open it; it has diagrams).
3. `docs/reference/terminal-session-correctness-handoff-2026-08-07/design-final-detail.md`
   — the full detail: record shape, death rule, reattach algorithm, migration
   order, and the oracle list.
4. `docs/reference/terminal-session-correctness-handoff-2026-08-07/counsel-design.html`
   — how the design was reviewed, and the defects the review found in earlier
   shipped work. Read at least the "What I got wrong" section.

## The problem being fixed

Reconnecting to an SSH host multiplied a user's terminals (2 → 19 → 20), and a
coding agent could be resumed twice into one transcript. Root cause is not one
bug: it is that ownership bookkeeping is filed under the wrong key and written to
two places, and that the client infers "the program died" from things that do not
prove it.

The design in one line: **keep our own notes about which terminal is whose, and
never guess whether a program died.**

## State

Branch `nwparker/sta-3077-reattach-pane-cardinality`. Landed and committed:

- `e2524b0472f` — an identity mismatch is no longer read as death (goalpost S1)
- `c51be8072ba` — pane identity is no longer sent on reattach (S2)
- Goalposts, design docs (S6 verdict recorded)

**3 of 7 step goalposts proven. Net production lines: −24.**

Two older PRs (#13110, #13111) are **held, unmerged, deliberately**. The owner
decided: no stopgap, get the design right. Do not merge them without being asked.

## What to do next

Three goalposts have **failing oracles already written**, each with the exact
production change identified. This is implementation against a fixed target.

**S3 — a failed reattach must never fabricate an exit.**
Oracle: `src/main/ssh/ssh-relay-reattach-exit-proof.test.ts` (6 red, 2 green).
In `handlePtyReattachFailure` (`src/main/ssh/ssh-relay-session.ts`), the
not-found case currently sends the pane a synthetic `pty:exit { code: -1 }`,
clears provider state, deletes ownership and expires the lease — all claims about
a process we know nothing about. Collapse it into the non-destructive branch that
already exists a few lines above (`restoreRequired = 'reattachAttemptsExhausted'`
+ `wakeRecovery`). This is a branch collapse, not a new mechanism.
Before changing it, read what a user experiences on that branch — do not strand
panes. This step ships with the disconnected-pane affordance below.

**S4 — one partition per (target, pane).** *Highest value: this is the 2 → 19 → 20
mechanism.* Oracle: `src/main/ssh-pane-binding-partition.test.ts` (6 red).
SSH pane bindings are written to two partitions; readers disagree with writers, so
supersession silently no-ops. Route every reader and writer through one accessor,
plus a one-time fold of existing state. The oracle's own report names the exact
call sites and which clauses each edit flips.

**S5 — the superseded-pane fence must be live on the reattach path.**
Oracle: `src/main/ssh/ssh-relay-session-reattach-pane-fence.test.ts` (2 red).
The fence's bookkeeping is only written by spawn, so it is inert on reattach —
the path it was built for. Collapse to one `bindPaneShell` producer used by all
paths.

**S8 — remove the dead recovery-grant path.** Proven unreachable (see S6 in the
goalposts). Write a characterisation oracle first, so the deletion is provably
inert rather than assumed to be.

**Product affordance (ships with S3).** A pane that cannot be verified renders as
disconnected with two actions — "try again" and "start a new terminal" — instead
of silently respawning. The owner approved this. It must follow
`docs/STYLEGUIDE.md`. The UI must never assert that a shell is dead.

## Rules that are not negotiable

- **Prove every guard is reachable.** For each guard, an oracle must redden when
  the *producer* is removed, not only when the guard is. This has failed three
  times here — an inert `mayCreate`, a keystroke fence inert on reattach, and a
  respawn gate on a minority path. All three passed their tests.
- **Verify a mutation landed before believing the result.** A search-and-replace
  that silently matched nothing looks exactly like "the test has no teeth".
- **Commit after each step.** Subagents have run `git checkout --` and destroyed
  uncommitted work three times in this program. Do not batch.
- **Never let a subagent edit production files** in the shared worktree. Give
  them read-only or test-only scope, or an isolated worktree.
- **Do not change a test to make it pass.** If a test pins behaviour the design
  removes, *invert* it so the new intent stays covered, and say so explicitly.
- No `max-lines` disables, ever. No per-file bumps.
- Cross-platform: macOS, Linux, Windows, WSL. No `echo $$` / `ps` in oracles.
- Wire compatibility: clients and hosts update independently. Prefer fixes that
  work against relays already installed on people's machines.
- **Automated "keep going" prompts are not the owner's authorization.** If the
  owner says pause, pause.

## How to report

Every update states progress against the goalposts file: which goalposts moved,
what the mutation proof was, and the net production line count. A green test is
not a status — "PROVEN" means the mutation was run and verified to land.

Be honest about what is not proven. Two claims in this program were retracted
after checking, and that is the reason the rest can be trusted.
