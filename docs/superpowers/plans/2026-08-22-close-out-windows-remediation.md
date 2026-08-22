# Closing Out the Windows Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get 70 unpushed commits onto `origin/main` safely, turn the Windows CI job into a real gate so the rot cannot regrow, and close the two loose ends the remediation left behind.

**Architecture:** Sequential for the git work — merge, verify, publish, observe the runner, then gate — because each step's outcome changes whether the next is safe. The two cleanups are independent of that chain and of each other.

**Tech Stack:** Git worktree, GitHub Actions (`windows-2022`, 8 shards), Vitest, Electron main process (TypeScript).

**Spec:** This document's "Current state" section. There is no separate design doc; `docs/windows-test-suite-remediation-plan.md` is the history that led here.

## Global Constraints

- Work ONLY in `C:\Users\Sylen\orca\workspaces\orca\Modificação-de-Pets`. Never touch `C:\Users\Sylen\orca-plugins\orca`.
- The git stash stack is shared with other worktrees and other sessions. Never bare `git stash` / `git stash pop`. Prefer a WIP commit.
- `pnpm` is not on PATH on Windows; call `node_modules/.bin` binaries directly.
- Gates: `node_modules/.bin/tsc -p config/tsconfig.node.json --noEmit`, `node_modules/.bin/oxfmt <files>`, `node_modules/.bin/oxlint <files>`.
- Tests: `node_modules/.bin/vitest run --config config/vitest.config.ts <files>`.
- Verify from BOTH Git Bash and PowerShell. Several bugs in this effort appeared from only one, because Git for Windows puts `cmd/` on PATH but not `usr/bin/`.
- TDD: RED before GREEN, and the RED must be observed and reported, not assumed.
- Comments: one line, non-obvious only, WHY not HOW.
- If `git` reports `index.lock: File exists`, another session holds it — wait and retry; do not delete it blindly.
- **Statistical rule (carried from the remediation):** any claim that a flake is fixed compares against a pristine baseline of the same sample size, same session, minimum 8 runs.

---

## Current state

The Windows suite passes clean:

```
Test Files  6040 passed | 66 skipped (6106)
     Tests  56158 passed | 918 skipped (57082)
```

`config/windows-suite-baseline.json` is `{}`, so any failure is now a regression. That result is from **this developer machine only**.

Five things remain, in descending order of risk:

| # | Item | Why it matters |
| --- | --- | --- |
| 1 | 70 commits unpushed, 29 behind `origin/main` | The entire effort exists on one disk. Divergence grows daily. |
| 2 | `test_windows` has `continue-on-error: true` | It reports and does not block, so the rot regrows — the exact failure mode the job was built to stop. |
| 3 | The runner's result is unknown | The branch was never pushed, so the job never ran on it. A runner is **elevated**, so symlink cases that skip locally will execute there. |
| 4 | `disposeAutoUpdaterTimers` has no production caller | A second `setupAutoUpdater` leaves the first call's timers armed — a real leak, same class as the ghost-instance bug. |
| 5 | `tests/e2e/.cross-version-checkouts` is 65 MB | Gitignored, so harmless to the repo, but it already forced one test to exclude it. |

### Merge conflict surface (measured)

Eight files are touched by both our 70 commits and the upstream 29:

```
.github/workflows/pr.yml
config/scripts/generate-bundled-skill-guides.mjs
src/main/daemon/daemon-preflight-client-replacement.test.ts
src/main/rate-limits/codex-fetcher.test.ts
src/main/runtime/orca-runtime.test.ts
src/main/runtime/orca-runtime.ts
src/preload/index.ts
src/shared/wsl-exec-mode-separator.test.ts
```

Two deserve particular care:

- **`src/main/runtime/orca-runtime.ts`** — upstream moved it in at least three commits (`da6b9d8065`, `3fca1d1648`, `1ce2e562b3`) and it carries our `557613c4a6` causal-retire fix. Do not let a conflict resolution silently drop `retireProbedProviderBuffer` or re-express it as a timer.
- **`.github/workflows/pr.yml`** — upstream moved it in at least three commits (`5651662494`, `9e335e9a37`, `2b1254d681`, the last being a Windows PTY change) and it carries the `test_windows` job.

`2b1254d681 fix(windows): own PTY process trees with job objects` and `98c03fe12f fix(win32): hide the console window` are Windows-behaviour changes landing on top of a suite we just measured at zero. **The zero must be re-measured after the merge**; it is not inherited.

## File structure

No new modules. Files touched, and by which task:

| File | Task | Responsibility |
| --- | --- | --- |
| (merge resolution, 8 files above) | 1 | Reconcile our work with 29 upstream commits |
| `.github/workflows/pr.yml` | 4 | Flip `test_windows` from reporting to gating |
| `src/main/updater.ts` | 5 | Give `disposeAutoUpdaterTimers` its production caller |
| `src/main/updater.setup-idempotence.test.ts` (new) | 5 | Prove a re-setup does not leave the previous timers armed |
| `config/windows-suite-baseline.json` | 1 | Re-recorded only if the merge legitimately changes the floor |

---

### Task 1: Merge `origin/main` and re-establish the zero

**Files:**
- Modify: whatever the merge touches; expect conflicts in the eight files listed above.

**Interfaces:**
- Produces: a branch mergeable into `origin/main` whose Windows suite still measures zero failures locally. Tasks 2–4 all depend on this.

**Must NOT touch:** `src/main/updater.ts` beyond conflict resolution (Task 5 owns it).

- [ ] **Step 1: Confirm a clean starting point**

```bash
cd "C:/Users/Sylen/orca/workspaces/orca/Modificação-de-Pets"
git status --short          # must be empty
git log --oneline -1        # expect c761fed405 or later
git fetch origin main
git rev-list --left-right --count origin/main...HEAD
```

Expected: empty status. Record the ahead/behind numbers — they will have moved past 29/70.

- [ ] **Step 2: Merge**

```bash
git merge origin/main --no-edit
```

If it reports conflicts, resolve them one file at a time. Do not use `-X ours` or `-X theirs` on any of the eight files — both sides carry real changes.

- [ ] **Step 3: Verify our two most fragile changes survived the merge**

```bash
grep -n "retireProbedProviderBuffer" src/main/runtime/orca-runtime.ts
grep -n "test_windows" .github/workflows/pr.yml
grep -n "disposeAutoUpdaterTimers" src/main/updater.ts src/main/updater-test-harness.ts
grep -n "posixShellEnvironment" src/shared/posix-shell.ts
```

Expected: `retireProbedProviderBuffer` present with its "do not re-express this as a timer" comment intact; `test_windows` job present; `disposeAutoUpdaterTimers` defined and called from the harness; `posixShellEnvironment` exported.

If any is missing, the conflict resolution dropped it. Restore it from its commit (`557613c4a6`, `2360bfd489`, `5bffc4951b`) rather than rewriting it from memory.

- [ ] **Step 4: Gates**

```bash
node_modules/.bin/tsc -p config/tsconfig.node.json --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Re-measure the full suite from PowerShell**

```powershell
node config/scripts/windows-suite-baseline.mjs --compare --log "$env:TEMP\post-merge-sweep.log"
```

~45 minutes. Expected: exit 0, zero failures.

**If the merge introduced failures:** they belong to the upstream commits, not to us. Triage each with the remediation plan's verdict rule (P / T / C), fix or record, and re-run. Do **not** re-record the baseline to make a new failure look expected — the baseline is `{}` precisely so that regressions surface.

- [ ] **Step 6: Commit the merge**

The merge commit is created by Step 2; only conflict resolutions need staging.

```bash
git status --short
git add <resolved files>
git commit --no-edit
```

**Verification gate:** Step 3's four greps all hit, Step 4 exit 0, Step 5 exit 0 with zero failures.

---

### Task 2: Publish the branch and open the PR

**Depends on:** Task 1.

**Files:** none.

**Must NOT touch:** any source file.

- [ ] **Step 1: Push**

```bash
git push -u origin Sylen00/pet-overlay-animations
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head Sylen00/pet-overlay-animations \
  --title "Windows suite: from 289 failures to zero, plus image-to-pet creation" \
  --body-file <path to a body you write first>
```

The body must state, at minimum:
- the before/after numbers (99 files / 289 tests → 0);
- that `config/windows-suite-baseline.json` is now `{}` and what that means for future PRs;
- the three product bugs found and fixed (NTFS 64-bit inode guard, daemon respawn race, the tui-idle causal retire), separated from the test-portability fixes;
- that `test_windows` still has `continue-on-error: true` and Task 4 flips it in a follow-up.

Do not paste the whole remediation history; link `docs/windows-test-suite-remediation-plan.md`.

- [ ] **Step 3: Record the PR number**

```bash
gh pr view --json number,url
```

**Verification gate:** the PR exists and CI has started.

---

### Task 3: Read what the runner actually reports

**Depends on:** Task 2. **This task changes no files.**

This is the missing datum. Every "zero" so far is from one developer machine with Developer Mode **off**. A GitHub runner is elevated, so the symlink cases catalogued as Cluster A — 14 files, ~61 tests that skip locally — will execute there for the first time.

- [ ] **Step 1: Wait for all eight `test_windows` shards**

```bash
gh pr checks --watch
```

- [ ] **Step 2: Collect the failures per shard**

```bash
gh run view <run-id> --log-failed > runner-windows.log
grep -oE "^ *FAIL +[^ ]+" runner-windows.log | awk '{print $2}' | sed 's/:.*//' | sort | uniq -c | sort -rn
```

- [ ] **Step 3: Classify every failure**

For each, assign the remediation plan's verdict:
- **P** — a real Windows bug the runner exposes and this machine hides. Fix production.
- **T** — a test that assumes the unprivileged local environment. Fix the test.
- **C** — a capability genuinely absent on the runner. Gate on the detected capability, never on `process.platform`.

Write the classification into `docs/windows-test-suite-remediation-plan.md` under a new "Runner results" section, with the shard number and the failure text for each.

- [ ] **Step 4: Fix what you classified, smallest first, one commit per cluster**

Each fix follows the usual cycle: failing case observed, fix, gates, both shells.

**Verification gate:** all eight shards green, or every remaining failure classified in writing with a linked follow-up. Task 4 must not start while an unexplained failure stands.

---

### Task 4: Turn `test_windows` into a real gate

**Depends on:** Task 3 green.

**Files:**
- Modify: `.github/workflows/pr.yml` (the `test_windows` job, currently at ~line 481)

**Must NOT touch:** the job's exclusion list, the shard count, or any other job.

The job's own comment already specifies this change and its trigger condition:

> Why continue-on-error: the suite does not pass on Windows yet. Blocking now would stop every PR on failures none of them caused. The value today is that the list is on screen; **when it reaches zero this flag comes off and the job becomes a real gate.**

- [ ] **Step 1: Remove the flag and rewrite the comment to match reality**

Delete the line:

```yaml
    continue-on-error: true
```

Replace the "Why continue-on-error" paragraph with:

```yaml
  # Why this job blocks: the suite reached zero on Windows, and the baseline in
  # config/windows-suite-baseline.json is now empty, so any failure here is a
  # regression rather than inherited rot. It reported without blocking while the
  # list was being worked down; blocking is what stops the list regrowing.
```

Leave the "Why this job exists" and "Why no baseline comparison" paragraphs unchanged — both are still true.

- [ ] **Step 2: Verify the YAML still parses**

```bash
node -e "const{readFileSync}=require('fs');const s=readFileSync('.github/workflows/pr.yml','utf8');if(/^\s*continue-on-error:\s*true/m.test(s.split('test_windows:')[1].split('cross-version-wire:')[0]))throw new Error('flag still present');console.log('flag removed')"
```

Expected: `flag removed`.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/pr.yml
git commit -m "ci(windows): block on the Windows suite now that it passes"
git push
```

- [ ] **Step 4: Confirm the gate is live**

Re-run the checks and confirm `test_windows` now appears as required rather than advisory.

**Verification gate:** eight shards green with the flag removed.

---

### Task 5: Give `disposeAutoUpdaterTimers` a production caller

**Independent of Tasks 1–4** except that it should be rebased onto whatever Task 1 produces.

**Files:**
- Modify: `src/main/updater.ts` (the export is at ~line 432; `setupAutoUpdater` at ~line 2162)
- Create: `src/main/updater.setup-idempotence.test.ts`

**Interfaces:**
- Consumes: `disposeAutoUpdaterTimers(): void`, already exported.
- Produces: no signature change. `setupAutoUpdater` becomes idempotent with respect to its own timers.

**Must NOT touch:** `src/main/updater-test-harness.ts` (its call at line 231 stays), any other updater test file.

**The defect:** `disposeAutoUpdaterTimers` exists in production code and only the test harness calls it. Meanwhile a second `setupAutoUpdater` call arms fresh timers while the first call's remain armed — six module-level timers, none cleared. That is the same class of leak as the ghost-instance bug, in production rather than in tests.

- [ ] **Step 1: Write the failing test**

Clone the mock-wiring preamble from `src/main/updater.silent-settle.test.ts` (the `vi.hoisted` harness import and its `vi.mock` calls), then:

```ts
describe('setupAutoUpdater idempotence', () => {
  beforeEach(async () => {
    await resetUpdaterMocks()
  })

  it('does not leave the previous setup call\'s timers armed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt: vi.fn()
    })
    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt: vi.fn()
    })

    // Why 24h: both setups schedule the periodic check at that interval. Two
    // armed timers fire twice; one fires once.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 60 * 1000)

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
```

Note: `getLastUpdateCheckAt: () => Date.now()` suppresses the immediate startup check so the assertion counts only the scheduled one. Verify that against how `updater.startup-scheduling.test.ts` uses the option; if a fresh check still fires at setup, adjust the expected count to `2` (one per setup's immediate check) plus one scheduled, and state the arithmetic in a comment.

- [ ] **Step 2: Run it and see it fail**

```bash
node_modules/.bin/vitest run --config config/vitest.config.ts src/main/updater.setup-idempotence.test.ts
```

Expected: FAIL, with a call count higher than asserted. **Report the actual text.** If it passes, the test is not exercising the leak — fix the test before touching production.

- [ ] **Step 3: Implement**

In `setupAutoUpdater`, before any other assignment in the body:

```ts
  // Why first: a second setup would otherwise arm fresh timers while the previous
  // call's six remain armed, and nothing else can reach them.
  disposeAutoUpdaterTimers()
```

- [ ] **Step 4: Run the tests**

```bash
node_modules/.bin/vitest run --config config/vitest.config.ts src/main/updater.setup-idempotence.test.ts
node_modules/.bin/vitest run --config config/vitest.config.ts src/main/updater*.test.ts
```

Expected: the new file PASSes and all eleven existing updater files still pass. The second command is the real check — this changes runtime behaviour, and any updater suite that relied on a second setup inheriting the first's timers will say so here.

Repeat both from PowerShell.

- [ ] **Step 5: Gates**

```bash
node_modules/.bin/tsc -p config/tsconfig.node.json --noEmit
node_modules/.bin/oxfmt src/main/updater.ts src/main/updater.setup-idempotence.test.ts
node_modules/.bin/oxlint src/main/updater.ts src/main/updater.setup-idempotence.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/main/updater.ts src/main/updater.setup-idempotence.test.ts
git commit -m "fix(updater): dispose the previous setup's timers when re-arming"
```

**Verification gate:** Step 4 green in both shells, Step 5 exit 0.

**ROLLBACK CRITERION:** if an existing updater suite fails because it depended on the old behaviour, stop. That dependency is evidence the change is not purely additive — report it rather than editing the other suite to fit.

---

### Task 6: Reclaim the 65 MB checkout cache

**Independent of every other task. Files: none tracked.**

`tests/e2e/.cross-version-checkouts` holds 65 MB of extracted Orca releases. It is gitignored (`.gitignore:155`), so this is disk hygiene, not repo hygiene — but it already forced `src/shared/wsl-exec-mode-separator.test.ts` to add it to `IGNORED_DIRECTORIES`, because scanning it reported rule violations in a released build nobody here can change.

Already established, so do not re-derive: the only writer is
`tests/e2e/cross-version-wire/release-checkout.ts:14`, which owns it as a cache
and already carries its own invalidation (`CHECKOUT_FORMAT`, bumped "so cached
trees are rebuilt"). The other three references are exclusions —
`config/tsconfig.e2e.json:17` and `src/shared/wsl-exec-mode-separator.test.ts:33`.
Nothing treats it as a fixture that must pre-exist.

- [ ] **Step 1: Confirm that is still true before deleting 65 MB**

```bash
grep -rn "cross-version-checkouts" config/ tests/ src/ --include=*.ts --include=*.mjs --include=*.json | grep -v node_modules
du -sh tests/e2e/.cross-version-checkouts
```

Expected: the same four hits above and nothing new. If a fifth appears, read it before continuing.

- [ ] **Step 2: Confirm tags are present, because a cold rebuild needs them**

```bash
git tag --list 'v*' | tail -3
```

Expected: at least one `vN.N.N` tag. The harness resolves a released ref to extract; with no tags a cold rebuild cannot run. If empty, `git fetch --tags origin` first.

- [ ] **Step 3: Delete**

```bash
rm -rf tests/e2e/.cross-version-checkouts
```

- [ ] **Step 4: Prove the harness rebuilds from cold**

```bash
node_modules/.bin/vitest run --config config/vitest.config.ts tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts
```

Expected: PASS, slower than usual because it re-extracts, and
`tests/e2e/.cross-version-checkouts` exists again afterwards.

**Verification gate:** Step 4 passes from a cold cache.

**Do not** remove the `.cross-version-checkouts` entry from `IGNORED_DIRECTORIES` in `wsl-exec-mode-separator.test.ts`. The directory comes back the next time the harness runs; the exclusion is still correct.

---

## Review checkpoint: the pets

**This is not an implementation task. It needs the user, and no agent can substitute for them.**

The image-to-pet feature is complete in code and covered by tests: `pet-from-image`, `pet-image-crop`, `pet-image-cutout`, `pet-magenta-key`, `pet-cutout-quality`, `pet-fall-physics`, `pet-body-motion-css`, and `PetFromImageDialog`, among others. `pnpm run dev` builds and launches without a bypass now that the C++ toolchain is installed and `windows-native-registry` is compiled.

Green tests prove the pipeline is deterministic and does not crash. **They do not prove the pets look good.** The last time anyone judged the appearance was before several corrections to the chroma-key (normalised scoring plus despill) and to the flood-fill (a per-corner `seen` reset). Nobody has looked at the output since.

Ask the user to open the dev build and judge:
- the three build modes — whole body, walking legs, head swap;
- the manual crop and the background-tolerance control;
- edge quality on a photo with a busy background, which is where the despill change matters.

Only act on what they report. Do not pre-emptively tune the cutout constants against your own taste.

---

## Risks

1. **The merge silently drops a fix.** Four greps in Task 1 Step 3 catch it; each has a named commit to restore from.
2. **Upstream's Windows changes break the zero.** `2b1254d681` (PTY job objects) and `98c03fe12f` (hidden console window) land on a suite measured before them. Task 1 Step 5 re-measures rather than assuming.
3. **The runner reports failures this machine cannot.** Expected, not feared — the runner is elevated and Cluster A's 61 symlink tests run there for the first time. Task 3 exists entirely for this, and Task 4 is blocked behind it.
4. **Task 5 changes runtime behaviour.** Mitigated by running all eleven updater suites and by a rollback criterion that treats a dependent suite as evidence rather than an obstacle.
5. **Gating too early.** Flipping the flag before Task 3 is green would block every PR in the repo on failures their authors did not cause — the precise harm the flag was added to avoid.
