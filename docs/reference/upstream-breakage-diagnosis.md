# Telling "my merge broke it" apart from "main was already broken"

Read this before diagnosing a branch that went red after merging `main`, and
before writing a repair brief for a stack that went red together.

## The mistake this exists to prevent

An eleven-PR chain merged `main` inside a window during which `main` itself was
broken: a dependency bump had broken a group of test shards, and a lint violation
was already sitting on `main`. Six of the eleven nodes went red. The reds were
diagnosed as damage caused by the merge, written up, and acted on. All of it was
wrong — the fix was to merge a newer `main`.

The tell was already in the data: **an identical failure multiset on every node,
including the root**. Damage from a merge varies with what each node changed.
Identical failures across an entire chain are upstream by construction.

## Why you cannot just look up main's CI

The obvious move is to ask GitHub whether `main` was green at a SHA. In this repo
that question has no answer, and it is worth knowing why before you go looking:

- `pr.yml` — the workflow that holds the tests, typecheck, static analysis and
  packaging — is `on: pull_request` only.
- `unit-tests.yml` is `workflow_call` only; nothing calls it from a push.
- No workflow runs the test suite on a push to `main`. The only lanes that ever
  execute on `main`'s own commits are scheduled or manually dispatched (E2E, the
  mac builds, terminal perf, node-next), plus a path-filtered skill round-trip.

The result is that a commit on `main` carries **zero** check runs:

```
$ gh api "repos/{owner}/{repo}/commits/<main-sha>/check-runs" --jq .total_count
0
```

The one lane that does run on `main` is scheduled E2E, twice a day, and it has
been uniformly red for weeks — so it cannot discriminate either.

So `main`'s health has to be reconstructed from the PRs whose CI ran against
`main` at that moment. That is what the probe does.

## What to run

```sh
# Was main broken at or near this commit?
pnpm run diagnose:upstream-breakage at <commit> --window-hours 1

# Are these red branches red for the same reason?
pnpm run diagnose:upstream-breakage compare 17330 17331 17332
```

Both finish in a few seconds. Both take `--json`.

`at` resolves the commit, finds the PRs whose checks completed in the surrounding
window, and reports each check's behaviour over time. `compare` does the same for
a list of PRs you name.

## How it decides

Every PR on which **a lane that actually executes the tree** ran in the window is
a **witness**. That qualification is the whole load-bearing part: a path-filtered
PR — docs-only, mobile-only — skips every lane in `pr.yml` and still posts three
green jobs (the path classifier, the root-directory guard and the LoC counter).
Those stay green on a `main` that is entirely broken, so a PR carrying only them
witnessed nothing and the probe refuses to count it. The list of qualifying lanes
is an allowlist in `upstream-breakage-evidence.mjs`: a name it does not recognise
costs a witness and pushes the verdict toward `unknown`, rather than buying one
and pushing it toward `clean`. Every unrecognised name is printed on each run.

For each check name the probe then looks at when it was red and when it was green:

| Shape                                                     | Meaning                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Red in every witness that ran it                          | `main` was broken for the whole window                                               |
| Red across one unbroken stretch of time, green outside it | `main` broke at the start of that stretch, and was fixed at the end if greens follow |
| Reds and greens interleave in time                        | branch-specific — the tree was fine between the reds                                 |
| Red in fewer than two independent stacks                  | not attributable either way                                                          |

Two PRs in the same stack share a diff, so they count as one witness, not two.
The probe reconstructs stacks from branch parentage: a PR whose base branch is
another PR's head branch is stacked on it, **and PRs that share one non-trunk base
branch are one stack even when that branch has no PR of its own** — otherwise two
children of an unlisted parent corroborate each other, which is one witness
counted twice.

The output for the real incident looks like this — the exact window, named:

```
test / tests node 24 2/8  — red 04:09Z..04:23Z (broke after 04:05Z; fixed by 04:39Z)
```

## It says unknown, and unknown is not green

The probe answers `broken`, `clean`, or `unknown`, and it will not say `clean`
without positive evidence. It answers `unknown` when:

- fewer than two PRs ran a lane that exercises the tree — including the case where
  every PR in the window was path-filtered down to its meta jobs;
- the witnesses are all in one stack, so they corroborate nothing;
- the witness checks are spread over more than a day, so they ran against
  different `main`s and their agreement means nothing;
- the commit sits in a blind gap — between the last green and the first red — so
  no witness observed `main` there;
- a failing check was seen too narrowly to attribute.

This is the same discipline as the `live` / `unverifiable` / `exited` vocabulary
in [`ssh-execution-boundary.md`](./ssh-execution-boundary.md). A health check
that guesses green is exactly the failure it is meant to catch.

## What it deliberately does not count

Printed on every run, never dropped silently:

- **`verify`** is a roll-up job that reprints another job's failure. Counting it
  double-counts one breakage and makes divergent failure sets look identical.
- **Known-false reds** — `test / tests node 24 1/8`, `test / tests node 24 6/8`,
  and `e2e / ssh docker watcher isolation` — are red for reasons unrelated to the
  commit. Counting them makes every window look broken. `--include-known-false`
  overrides this.
- **Third-party app checks** (review bots) say nothing about the tree.
- **Skipped checks** are not passes, and neither are the always-on jobs that never
  execute the tree — `detect code-relevant changes`, `root directory guard`,
  `test vs non-test LoC`, `track-community-pr`, and the e2e spec-list classifiers.
  A PR left with only those is not a witness at all, so a window made up of
  path-filtered PRs reads `unknown`, not `clean`.
- **`verify`** is also the job name of the mobile workflow's only lane, so a
  mobile-only PR loses that check to the roll-up exclusion as well. It is not a
  witness for `main`'s desktop health either way.

## Traps to keep in mind

- `gh pr list` and `gh run list` **truncate silently** — the default is 30 rows.
  The probe always passes an explicit `--limit`, prints the count it scanned, and
  warns when the result came back exactly at the limit. If you query by hand, do
  the same, and print the count beside any conclusion.
- A run's `conclusion` **hides failed first attempts**: a run re-run to green
  reads `success`. Pass `--all-attempts` when attempt-level truth matters.
- Read `main` and the workflow definitions from `origin/main`, not from a
  worktree. A checkout fourteen commits behind gives a confidently wrong answer.
- The probe cannot see which base SHA each PR's CI actually merged against, only
  when it ran. Two checks minutes apart can still straddle a merge. That is why
  a narrow `--window-hours` sharpens the answer and why blind gaps read `unknown`.

## When it says upstream

Merge a newer `main` into each branch. Do not repair the branches, do not write
the failures up as merge damage, and do not rebase the chain — see
[`git-compatibility.md`](./git-compatibility.md) for the Git-side constraints on
restacking.
