# Task 6 Report: Reclaim the 65 MB checkout cache

**Status: DONE**

HEAD before and after: `69d8de62ab5e0bc0b45c04480e6d8feda715e3c1` (no commit made — nothing tracked to commit; `.cross-version-checkouts` is gitignored). `git status` confirms clean working tree throughout, including after the rebuild.

## Step 1: Confirm the reference set before deleting

```
$ grep -rn "cross-version-checkouts" config/ tests/ src/ --include=*.ts --include=*.mjs --include=*.json | grep -v node_modules
config/tsconfig.e2e.json:17:  "exclude": ["../tests/e2e/.cross-version-checkouts/**"],
tests/e2e/cross-version-wire/release-checkout.ts:14:const CACHE_ROOT = join(REPO_ROOT, 'tests', 'e2e', '.cross-version-checkouts')
src/shared/source-scan/source-tree-scan.ts:10: * to scan `tests/e2e/.cross-version-checkouts/` and report 21 offenders that
src/shared/wsl-exec-mode-separator.test.ts:25:// tests/e2e/.cross-version-checkouts/. Those are shipped code we cannot edit, so
```

Four hits total, matching the brief's expectation ("the same four hits above and nothing new"). No fifth hit appeared, so no stop was needed. Notes on the two hits not spelled out verbatim in the brief's line numbers:

- `src/shared/source-scan/source-tree-scan.ts:10` is a doc comment explaining the *history* of why the shared file-walk helper exists (a past guard scanned the checkout cache and reported 21 false offenders). It is not a functional reference and does not treat the directory as a fixture.
- `src/shared/wsl-exec-mode-separator.test.ts` no longer has a literal `'cross-version-checkouts'` string in `IGNORED_DIRECTORIES` at line 33 as the brief described — confirming the brief's own caveat that an upstream merge already replaced that single-name Set entry with a dot-directory prefix rule (`IGNORED_DIRECTORY_PREFIX = '.'`, added alongside `IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])`). The only remaining occurrence of the literal string in that file is the explanatory comment now at line 25. Per instructions, this file was left untouched.

Conclusion: the only writer is `tests/e2e/cross-version-wire/release-checkout.ts:14`; everything else is either an exclusion or a historical comment. Safe to delete.

```
$ du -sh tests/e2e/.cross-version-checkouts
65M	tests/e2e/.cross-version-checkouts
```

## Step 2: Confirm tags are present

```
$ git tag --list 'v*' | tail -5
v1.4.98-rc.6
v1.4.98-rc.7
v1.4.98-rc.8
v1.4.98-rc.9
v1.4.99
```

Tags present — no `git fetch --tags` needed.

## Step 3: Delete

```
$ rm -rf tests/e2e/.cross-version-checkouts
```

Confirmed removed (directory listing came back empty / grep for it exited 1).

## Step 4: Prove the harness rebuilds from cold

```
$ time (node_modules/.bin/vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts)

 RUN  v4.1.5 C:/Users/Sylen/orca/workspaces/orca/Modificação-de-Pets

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  22:23:28
   Duration  47.41s (transform 19.39s, setup 40ms, import 96ms, tests 46.94s, environment 0ms)

real	0m48.798s
```

**Result: PASS.** 5/5 tests passed, 1/1 test file passed. Wall time ~48.8s, of which the vitest-reported test-body time (46.94s) is dominated by the cold re-extraction of the release checkouts — this is markedly slower than a warm run would be (warm runs typically finish this file in well under 5s, since the harness only checks a `CHECKOUT_FORMAT`-tagged cache marker and returns).

Post-run disk state:

```
$ ls tests/e2e/.cross-version-checkouts
v1.4.184
$ du -sh tests/e2e/.cross-version-checkouts
65M	tests/e2e/.cross-version-checkouts
```

The cache directory exists again and reclaimed the same 65 MB it held before deletion (before: 65M, after cold rebuild: 65M — no drift). Disk was reclaimed for the duration between Step 3 and Step 4's completion (~49 seconds) and then re-spent by the same test run that proved the rebuild works; running the full test suite subsequently will keep the cache warm rather than paying this cost again.

## Verification gate

Step 4 passed from a cold cache. Gate met.

## Commits

None. `.cross-version-checkouts` is gitignored (`.gitignore:157`); this is disk hygiene only. `git status` was clean before, during (directory absent), and after (directory rebuilt but untracked) the task.

## Concerns

None. The one judgement call in the brief (cold rebuild failing for an environmental reason such as missing tags or network) did not arise — tags were present, extraction succeeded, and the test suite passed cleanly on the first attempt.

The one deviation worth flagging explicitly: Step 1's grep surfaced a hit not named verbatim by line number in the brief (`src/shared/source-scan/source-tree-scan.ts:10`), and the `wsl-exec-mode-separator.test.ts` line number differed from the brief's `:33` (actual: `:25`, a comment, since the actual `IGNORED_DIRECTORIES` Set entry for this path was already replaced upstream by the dot-prefix rule the brief's context section warned about). Both were read and confirmed non-functional/historical before proceeding, per the brief's "read it before continuing" instruction for any unexpected hit. `wsl-exec-mode-separator.test.ts` was not modified.

## Addendum: plan-document correction (post-review, Ruling 7)

Review confirmed the execution as spec-faithful: all four Step 1 reference hits reproduced line-for-line, `release-checkout.ts:14` confirmed as the sole writer with real stamp-based invalidation at `:206`, and the guardrail file (`wsl-exec-mode-separator.test.ts`) confirmed untouched. The two Important findings from review were about the plan's premise, not the execution, and the coordinator ruled on them directly (Ruling 7).

Corrected `docs/superpowers/plans/2026-08-22-close-out-windows-remediation.md`:

- **Current state table, item 5** (line 47): reworded from "Gitignored, so harmless to the repo, but it already forced one test to exclude it" to state plainly that the directory is a self-healing build cache with its own `CHECKOUT_FORMAT` invalidation, that the harness rebuilds it to the same size, and that the exclusion it needed is incidental (a generic dot-directory prefix rule) rather than purpose-built.
- **Task 6 section**: fixed the `.gitignore` citation (`:155` → `:157`, matching the corrected citation below) and added a `> **Post-execution correction (Ruling 7)**` blockquote immediately after the original framing paragraph — left that paragraph's original wording intact as the historical record of the plan's premise, per the coordinator's instruction not to rewrite history to look better. The correction block states, in the coordinator's terms: (1) the task reclaims nothing durable — net disk effect is zero, measured (~48.8s to rebuild to an identical 65 MB); (2) what it actually verified — a real regression check on `release-checkout.ts`'s cold-extraction path, which is worth having but is not disk hygiene; (3) the `IGNORED_DIRECTORIES` justification is stale — an upstream merge had already replaced the single-name carve-out with a generic `IGNORED_DIRECTORY_PREFIX = '.'` rule before this task ran, so the literal string survives only in a comment (now line 25, not the `:33` `IGNORED_DIRECTORIES` entry the plan cited).
- This report's own `.gitignore` citation was also corrected from `:155` to `:157`.

Also corrected in this report (this section): `.gitignore:157` is the actual rule location, not `:155` as stated in the original Step 1 write-up above and in the original plan text.

Constraints observed: no source or test files touched, only the plan document and this report; `rm -f ./NUL` run before staging; plan staged with `git add -f` since `docs/` is gitignored; no destructive git operations used.
