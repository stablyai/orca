---
name: auto-pr-merge
description: Create PR, wait for checks, fix issues iteratively, and merge with --admin
---

# auto-pr-merge

End-to-end autonomous PR workflow: create PR, wait for CI checks to pass, fix any issues (typecheck, code review), update PR, and merge with admin override. Runs fully autonomously without user confirmation.

**IMPORTANT**: Execute this entire process autonomously without asking the user for confirmation at any step. Just do it.

---

## Process Overview

```
  CREATE PR  →  WAIT FOR CHECKS  →  FIX LOOP (max 3)  →  MERGE --admin
     │               │                    │                     │
  /create-pr    1min + 1min polls    diagnose CI           gh pr merge
                 (up to ~6min)       fix issues             --admin
                                     pn typecheck           --squash
                                     /review-code           --delete-branch
                                     commit & push
                                     wait for checks
```

---

## Step 1: Create PR

Run the `/create-pr` skill to create or update the pull request.

```
Use the Skill tool: skill: "create-pr"
```

After `/create-pr` completes, extract the PR number and URL:

```bash
gh pr view --json number,url --jq '.number, .url'
```

Store the PR number for later use.

**CRITICAL: DO NOT STOP after /create-pr completes. Continue to Step 2.**

---

## Step 2: Wait for PR Checks

Use the **Check Polling Procedure** (defined below) to wait for CI checks. Based on the result:

- `PASSED` → Skip to Step 4 (MERGE)
- `FAILED` → Proceed to Step 3 (FIX LOOP)
- `NO_CHECKS` → Skip to Step 4 (MERGE) — no CI configured, nothing to wait for

---

## Step 3: Fix Loop (Max 3 Iterations)

Run up to **3 iterations** of the diagnose-fix-review-push cycle.

### 3a. Diagnose Failures

Identify which checks failed and get their logs:

```bash
# Get the most recent failed run ID for this branch
FAILED_RUN=$(gh run list --branch $(git branch --show-current) --limit 5 --json databaseId,conclusion,name --jq '[.[] | select(.conclusion == "failure")] | .[0].databaseId')
echo "Failed run: $FAILED_RUN"

# View failed step logs (truncated to last 200 lines to avoid context bloat)
if [ -n "$FAILED_RUN" ] && [ "$FAILED_RUN" != "null" ]; then
    gh run view "$FAILED_RUN" --log-failed 2>&1 | tail -200
fi
```

If `gh run view --log-failed` returns too much output or doesn't work, fall back to:

```bash
gh run view "$FAILED_RUN" --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name, steps: [.steps[] | select(.conclusion == "failure") | {name, conclusion}]}'
```

### 3b. Fix Issues

Based on the failure diagnosis:

1. **Read the error output** from the failed checks
2. **Identify the root cause** (build error, lint error, test failure, type error, etc.)
3. **Apply fixes** using the Edit tool
4. **Delegate to specialized skills when appropriate**:
   - **Lint errors**: Run `/fix-lint` skill
   - **Build errors**: Run `/fix-build` skill
   - **Test failures**: Read failing test, fix the code or test manually

### 3c. Run Typecheck

After applying fixes, verify types are clean:

```bash
pn typecheck 2>&1
```

- If typecheck passes: continue to 3d
- If typecheck fails: fix type errors and re-run (up to 3 attempts within this step)
  - Read the error output
  - Fix the type errors
  - Re-run `pn typecheck`
- If still failing after 3 attempts: move on to 3d anyway (CI will catch remaining issues)

### 3d. Run Code Review (Quick Round)

Run **only** `/review-code` to catch any issues introduced by the fixes. Do NOT run `/review-correctness`, `/review-via-codex`, `/review-algorithm-architecture`, or any other review skill — only `/review-code`:

```
Use the Skill tool: skill: "review-code"
```

After review completes:
- If **Critical or High** issues found: fix them using the Edit tool, then re-run `pn typecheck` to verify the review fixes don't introduce type errors
- If only **Medium or Low** issues: acceptable, continue
- If **no issues**: continue

### 3e. Update PR

Commit and push only if there are actual changes:

```bash
# Check if there are changes to commit
if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -m "fix: address CI failures and review feedback"
    git push --force-with-lease
else
    echo "NO_CHANGES"
fi
```

- If `NO_CHANGES`: No fixes were needed/possible. Exit the fix loop and proceed to Step 4.
- If changes were pushed: continue to 3f.

### 3f. Wait for PR Checks Again

Use the **Check Polling Procedure** (defined below) to wait for CI checks. Based on the result:

- `PASSED` → Exit fix loop, proceed to Step 4
- `FAILED` → Next iteration of fix loop (back to 3a)
- `NO_CHECKS` → Exit fix loop, proceed to Step 4

If max 3 fix iterations reached, proceed to Step 4 anyway.

---

## Step 4: Merge with --admin

Merge the PR using admin override with squash merge.

**IMPORTANT: Worktree detection.** When running from a git worktree, `--delete-branch` will fail because `gh` tries to checkout the default branch locally, but it's already checked out in the main worktree. Detect this and handle accordingly:

```bash
# Check if we're in a worktree (not the main working tree)
IS_WORKTREE=false
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
    IS_WORKTREE=true
fi

BRANCH=$(git branch --show-current)

if [ "$IS_WORKTREE" = "true" ]; then
    # In a worktree: merge WITHOUT --delete-branch, then delete remote branch separately
    gh pr merge --admin --squash
    # Delete the remote branch manually (local cleanup happens when worktree is removed)
    git push origin --delete "$BRANCH" 2>/dev/null || true
else
    # Normal repo: use --delete-branch as usual
    gh pr merge --admin --squash --delete-branch
fi
```

- `--admin` bypasses branch protection rules (required reviews, status checks)
- `--squash` squashes all commits into one clean commit
- `--delete-branch` cleans up the feature branch after merge (skipped in worktrees to avoid checkout conflict)

If merge fails:
1. Check the error message
2. If the error contains `'master' is already used by worktree` or similar: retry without `--delete-branch` and delete the remote branch manually with `git push origin --delete <branch>`
3. If merge conflicts: use Skill tool with `skill: "resolve-conflicts"`, push, then retry merge once
4. If other error: report the full error to the user

---

## Check Polling Procedure

This is the shared polling logic used by Step 2 and Step 3f. **Do NOT run this as a single long bash command** — the Bash tool will timeout. Instead, run each poll as a **separate Bash call**.

**IMPORTANT: Minimize token waste.** Do NOT add verbose commentary between polls. Just run the wait, run the check, and act on the result. No cheerful status messages, no "patience is key", no filler text.

### Initial wait

After a push, CI takes time to run. Wait **1 minute** before the first poll:

```bash
echo "Waiting 1 minute for CI checks to run..." && sleep 60
```

**IMPORTANT**: You MUST actually execute the `sleep 60` command and wait for it to complete. Do NOT skip the sleep or claim you waited without running the command. The sleep ensures CI has time to finish.

**CRITICAL**: When calling the Bash tool for `sleep 60`, you MUST set `timeout: 120000` (2 minutes) on the Bash tool call. Similarly, for `sleep 60` poll interval calls, set `timeout: 120000` (2 minutes).

### Poll loop (run each poll as a separate Bash call)

For each poll attempt (1 through 5):

```bash
CHECKS=$(gh pr checks --json name,state,bucket 2>&1)
echo "$CHECKS"

# Parse results using 'bucket' field (pass, fail, pending, skipping, cancel)
if echo "$CHECKS" | jq -e 'length == 0' >/dev/null 2>&1; then
    echo "RESULT:NO_CHECKS"
elif echo "$CHECKS" | jq -e '[.[].bucket] | all(. == "pass" or . == "skipping")' >/dev/null 2>&1; then
    echo "RESULT:PASSED"
elif echo "$CHECKS" | jq -e '[.[].bucket] | any(. == "fail" or . == "cancel")' >/dev/null 2>&1; then
    echo "RESULT:FAILED"
else
    echo "RESULT:PENDING"
fi
```

### Decision logic after each poll

- `RESULT:PASSED` → Return `PASSED`. Stop polling.
- `RESULT:FAILED` → Return `FAILED`. Stop polling.
- `RESULT:PENDING` → Wait **1 minute**, then poll again (use `timeout: 120000` on the Bash tool call):
  ```bash
  sleep 60
  ```
- `RESULT:NO_CHECKS` → Return `NO_CHECKS` (no CI configured).

### After 5 polls (timeout)

If checks are still pending after 5 polls (~6 min total), return `FAILED` to enter the fix loop for investigation.

### Handling stale checks after re-push (Step 3f only)

After pushing new commits in Step 3e, old check results may linger briefly. To avoid reading stale results:

1. Record the latest commit SHA **before pushing**: `OLD_SHA=$(git rev-parse HEAD)`
2. After pushing, the first 1-2 polls should verify the check suite is for the **new** commit. If `gh pr checks` still shows the old results (check names match but they completed instantly), wait an extra 30s.
3. Alternatively, look for checks with `state: "IN_PROGRESS"` or `"QUEUED"` as a signal that fresh checks have started.

---

## Exit Conditions

- **Success**: PR merged successfully
- **Max fix iterations**: After 3 fix loop iterations, attempt merge with --admin regardless
- **No changes to fix**: Fix loop produced no changes, merge with --admin
- **No CI checks**: Repo has no checks configured, merge immediately
- **Unrecoverable error**: PR creation fails, merge fails after retry, or gh CLI issues

---

## Progress Tracking

Display progress after each major step:

```
╔════════════════════════════════════════════════════════════╗
║  AUTO PR MERGE                                             ║
╠════════════════════════════════════════════════════════════╣
║  Step 1 - Create PR:       ✅ PR #123 created              ║
║  Step 2 - Wait for checks: ❌ 2/5 checks failed           ║
║  Step 3 - Fix Loop:                                        ║
║    Iteration 1/3:                                          ║
║      Diagnose:   ✅ Type errors in 2 files                 ║
║      Fix:        ✅ Fixed type errors                      ║
║      Typecheck:  ✅ Passed                                 ║
║      Review:     ✅ No critical issues                     ║
║      Push:       ✅ Updated PR                             ║
║      Checks:     ✅ All passed                             ║
║  Step 4 - Merge:            ✅ Merged with --admin --squash ║
╠════════════════════════════════════════════════════════════╣
║  PR URL: https://github.com/org/repo/pull/123              ║
║  Result: Successfully merged!                              ║
╚════════════════════════════════════════════════════════════╝
```

---

## Critical Instructions

1. **DO NOT ask for user confirmation** - Execute the entire workflow autonomously
2. **DO NOT stop after /create-pr** - The PR creation is just step 1 of 4
3. **DO NOT stop after checks pass** - Must complete the merge step
4. **DO NOT run polling as a single long bash loop** - Each poll must be a separate Bash call to avoid the 2-minute Bash timeout. Use `sleep` in its own Bash call between polls.
5. **DO wait the full polling period** - Don't skip check waiting; CI needs time
6. **DO run typecheck before review** - Catch type errors early
7. **DO run /review-code in each fix iteration** - Ensure code quality
8. **DO check for actual changes before committing** - Skip commit/push if `git status --porcelain` is empty
9. **DO use --admin for merge** - This is intentional to bypass protection rules
10. **DO use --squash for merge** - Keep git history clean
11. **DO delete branch after merge** - Clean up with --delete-branch
12. **Maximum 3 fix iterations** - Don't loop forever; after 3, merge with --admin
13. **DO NOT run /review-correctness or /review-via-codex** - This skill only uses `/review-code` for quick checks in the fix loop. Codex-based reviews are slow and belong in `/auto-review-fix`, not here.
14. **DO actually execute sleep commands** - When the skill says `sleep 60`, you MUST run the bash command and wait for it to complete. Do not skip or fabricate the wait.
15. **DO set timeout on Bash tool for sleep commands** - `sleep 60` requires `timeout: 120000`. The default 2-minute Bash timeout is sufficient for 1-minute sleeps but set it explicitly for safety.

---

## Error Handling

- If `/create-pr` fails: Report error and exit
- If `gh` CLI is not installed or authenticated: Report and exit
- If no CI checks are configured: Skip waiting and merge directly
- If check polling times out: Enter fix loop to investigate
- If typecheck loops more than 3 times within a single fix iteration: Move on to review
- If fix loop produces no changes: Exit loop and merge with --admin
- If merge fails due to conflicts: Try `/resolve-conflicts`, push, then retry merge once
- If merge fails for other reasons: Report the error to the user with the full error output
