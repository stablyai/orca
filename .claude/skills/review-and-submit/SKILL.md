---
name: review-and-submit
description: Lightweight review-fix loop (2 rounds, 1 agent each), then create PR and merge
---

# review-and-submit

Lightweight autonomous pipeline: review code with a single agent, fix issues (up to 2 rounds), then create PR and merge. Designed for smaller PRs where full parallel review is overkill.

**IMPORTANT**: Execute this entire process autonomously without asking the user for confirmation at any step.

---

## Process Overview

```
  REVIEW-FIX (max 2 rounds, 1 agent each)  →  CREATE PR  →  WAIT FOR CI  →  MERGE
```

---

## Step 1: Review-Fix Loop (Max 2 Rounds)

### Round Setup (first round only)

Get the diff to understand what changed:

```bash
MERGE_BASE=$(git merge-base origin/main HEAD)
git diff $MERGE_BASE --stat
git diff $MERGE_BASE
```

### Each Round: Single-Agent Review

Spawn **one** review agent that covers all review concerns:

```
Agent(
  subagent_type: "general-purpose",
  model: "opus",
  description: "Review all changes on branch",
  prompt: """
    Review all code changes on this branch vs origin/main.

    Run: git diff $(git merge-base origin/main HEAD)

    Review for:
    - Correctness and logical bugs
    - Security issues
    - Type safety issues
    - Error handling gaps
    - Performance problems
    - Dead code or unused imports

    **SCOPE**: Only report issues in changed code or directly caused by the changes.
    Do NOT report pre-existing issues unrelated to this PR.

    For each finding, output:
    - File: path/to/file.ts
    - Line: NN
    - Severity: Critical|High|Medium|Low
    - Issue: [description]
    - Fix: [suggested fix]

    If no issues found, say "No issues found."
  """
)
```

### Fix Phase

If the review found issues:

1. **Skip Low severity issues** — only fix Critical, High, and Medium
2. Fix issues via a single fix agent:

```
Agent(
  subagent_type: "general-purpose",
  model: "opus",
  description: "Fix review issues",
  prompt: """
    Fix the following review issues:

    [LIST ALL CRITICAL/HIGH/MEDIUM ISSUES FROM REVIEW]

    Instructions:
    1. Read each file
    2. Apply fixes using the Edit tool
    3. Verify fixes don't break syntax
    4. Report what was fixed
  """
)
```

3. After fixes, run typecheck:

```bash
pnpm typecheck 2>&1
```

If typecheck fails, fix type errors (up to 2 attempts).

### Exit Conditions

```
IF (review found no Critical/High/Medium issues):
    → EXIT loop — code is clean

IF (fixes applied):
    → Run another round to verify (unless already at round 2)

IF (round 2 reached):
    → EXIT loop
```

### Commit Changes

After the review-fix loop completes, commit any changes:

```bash
if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -m "fix: address review findings"
fi
```

**Continue to Step 2 — do not stop here.**

---

## Step 2: Create PR and Merge

### 2a. Create PR

**FIRST**: Push the branch to the remote so `gh pr create` doesn't fail with
`aborted: you must first push the current branch to a remote`. The
`create-pr` skill rebases locally but does not always push before invoking
`gh pr create`, and `gh` refuses to create a PR for an un-pushed branch.

```bash
git push --force-with-lease -u origin HEAD
```

Then invoke:

```
Use the Skill tool: skill: "create-pr"
```

After `/create-pr` completes, extract PR info:

```bash
gh pr view --json number,url --jq '.number, .url'
```

### 2b. Wait for CI Checks

Wait **2.5 minutes** before the first poll:

```bash
echo "Waiting 2.5 minutes for CI checks..." && sleep 150
```

**CRITICAL**: Set `timeout: 210000` (3.5 minutes) on the Bash tool call for this sleep.

### Poll for results (up to 5 polls, 90s apart)

For each poll:

```bash
CHECKS=$(gh pr checks --json name,state,bucket 2>&1)
echo "$CHECKS"

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

- `PASSED` → Proceed to merge
- `FAILED` → Attempt one quick fix iteration (diagnose from `gh run view --log-failed`, fix, push, re-poll)
- `PENDING` → Wait 90s (`sleep 90`, `timeout: 150000`), then poll again
- `NO_CHECKS` → Proceed to merge

### 2c. Merge

```bash
IS_WORKTREE=false
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
    IS_WORKTREE=true
fi

BRANCH=$(git branch --show-current)

if [ "$IS_WORKTREE" = "true" ]; then
    gh pr merge --admin --squash
    git push origin --delete "$BRANCH" 2>/dev/null || true
else
    gh pr merge --admin --squash --delete-branch
fi
```

---

## CI Fix Loop (if checks fail)

If CI fails after PR creation, run **one** fix iteration:

1. Diagnose:

```bash
FAILED_RUN=$(gh run list --branch $(git branch --show-current) --limit 5 --json databaseId,conclusion,name --jq '[.[] | select(.conclusion == "failure")] | .[0].databaseId')
if [ -n "$FAILED_RUN" ] && [ "$FAILED_RUN" != "null" ]; then
    gh run view "$FAILED_RUN" --log-failed 2>&1 | tail -200
fi
```

2. Fix the issues, run `pnpm typecheck`, commit and push:

```bash
if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -m "fix: address CI failures"
    git push --force-with-lease
fi
```

3. Wait 2.5 minutes and re-poll. If still failing after one fix attempt, merge with `--admin` anyway.

---

## Progress Tracking

```
╔════════════════════════════════════════════════════════════╗
║  REVIEW AND SUBMIT                                         ║
╠════════════════════════════════════════════════════════════╣
║  Review-Fix Loop:                                          ║
║    Round 1: ✅ X issues found, Y fixed                     ║
║    Round 2: ✅ Clean review                                 ║
║  Create PR:   ✅ PR #123                                   ║
║  CI Checks:   ✅ Passed                                    ║
║  Merge:       ✅ Merged with --admin --squash               ║
╠════════════════════════════════════════════════════════════╣
║  PR URL: https://github.com/org/repo/pull/123              ║
╚════════════════════════════════════════════════════════════╝
```

---

## Critical Instructions

1. **DO NOT ask for user confirmation** — Execute autonomously
2. **Max 2 review rounds**, 1 agent per round — keep it lightweight
3. **Only fix Critical/High/Medium** — skip Low severity
4. **DO run typecheck** after fixes
5. **DO use opus model** for review and fix agents
6. **2.5 minute initial CI wait** (not 8 minutes) — this repo's CI is fast
7. **DO use --admin --squash** for merge
8. **DO set Bash timeouts** for sleep commands
9. **Continue through all steps** — don't stop after review or PR creation
10. **One CI fix iteration max** — don't loop forever on CI failures
