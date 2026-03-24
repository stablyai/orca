---
name: auto-review-fix
description: Automated iterative code review and fix loop with parallel review agents
---

# auto-review-fix

Automated iterative code review and fix loop. Reviews all code changes on the current branch since it diverged from main, including uncommitted changes (staged and unstaged). Validates findings, fixes issues, and repeats until clean or max iterations reached.

**IMPORTANT**: Execute this entire process autonomously without asking the user for confirmation at any step. Just do the iterations.

---

## Process Overview

Run up to **4 iterations** of the review-validate-fix cycle. Stop early ONLY when a **follow-up review confirms no issues to fix** remain.

```
┌─────────────────────────────────────────────────────────────┐
│  ITERATION LOOP (max 4 rounds)                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 0. SETUP PHASE (first iteration only)              │    │
│  │    - Fetch diff and create 00-review-context.md    │    │
│  │    - Categorize files by review area               │    │
│  │    - Deduplicate file assignments                  │    │
│  └─────────────────────────────────────────────────────┘    │
│                         ↓                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 1. PARALLEL REVIEW PHASE                           │    │
│  │    - Spawn Task() subagents for each review area   │    │
│  │    - Each receives ONLY their relevant files       │    │
│  │    - All reference shared 00-review-context.md     │    │
│  └─────────────────────────────────────────────────────┘    │
│                         ↓                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 2. COMBINE & DEDUPLICATE                           │    │
│  │    - Aggregate all findings                        │    │
│  │    - Deduplicate across review areas               │    │
│  │    - Exclude previously-skipped issues             │    │
│  └─────────────────────────────────────────────────────┘    │
│                         ↓                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 3. VALIDATE PHASE (all severities)                 │    │
│  │    - Validate all issues (Critical to Low)         │    │
│  │    - Skip issues already in "Skipped Issues" list  │    │
│  │    - Group by file, one agent per file             │    │
│  └─────────────────────────────────────────────────────┘    │
│                         ↓                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 4. FIX PHASE                                       │    │
│  │    - Group issues by file (up to 5 per agent)      │    │
│  │    - Each fix done via Task() with opus             │    │
│  └─────────────────────────────────────────────────────┘    │
│                         ↓                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 5. CHECK EXIT CONDITIONS                           │    │
│  │    - Fixed issues? → MUST run another review       │    │
│  │    - Review shows no issues? → EXIT                │    │
│  │    - Iteration 4 reached? → EXIT                   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Setup (First Iteration Only)

### Step 1: Fetch the diff

```bash
# Get the merge base (where the branch diverged from main)
git diff $(git merge-base origin/main HEAD)
```

### Step 1.5: Check diff size

```bash
# Count changed files
git diff $(git merge-base origin/main HEAD) --stat | tail -1
# If >500 files changed, exit with recommendation to split PR
```

If the diff contains more than 500 changed files, **EXIT immediately** with:

```
❌ Diff too large (>500 files). Please split this PR into smaller, focused changes.
```

### Step 2: Create shared context file

Create `00-review-context.md` in the working directory (see below for format).

### Step 2.5: Extract changed line ranges

Parse `git diff $(git merge-base origin/main HEAD) --unified=0` to extract line ranges (`@@ +A,B @@` → lines A to A+B-1). Add to context file below.

### Step 2 (continued): Context file format

Create `00-review-context.md` in the working directory with:

```markdown
# Review Context

## Branch Info

- Base: origin/main
- Current: [branch name]

## Changed Files Summary

[List all changed files with their change type: A/M/D]

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File               | Changed Lines    |
| ------------------ | ---------------- |
| [path/to/file1.ts] | [45-67, 120-135] |
| [path/to/file2.ts] | [10-25]          |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

[Categorized list - see below]

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->
<!-- NOTE: Skips should be RARE - only purely cosmetic issues with no functional impact -->

[Initially empty - populated during validation phase]

## Iteration State

<!-- Updated after each phase to enable crash recovery -->

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
```

**IMPORTANT**: The "Skipped Issues" section persists across iterations. However, skips should be RARE - only purely cosmetic issues (naming, JSDoc, import ordering) may be skipped. Functional issues like error handling, type safety, and performance must ALWAYS be fixed.

### Step 3: Categorize and deduplicate files

Assign each file to **exactly ONE** file category (no duplicates):

| Priority | Category       | File Patterns                                                    |
| -------- | -------------- | ---------------------------------------------------------------- |
| 1        | Electron/Main  | `src/main/`, `src/preload/`, `electron.*`                        |
| 2        | Backend/IPC    | `*ipc*`, `*handler*`, `*service*` (in main process)              |
| 3        | Frontend/UI    | `src/renderer/`, `components/`, `*.tsx`, `*.css`                 |
| 4        | Config/Build   | `*.config.*`, `package.json`, `tsconfig.*`, `electron-builder.*` |
| 5        | Utility/Common | Everything else                                                  |

**Deduplication rule**: A file belongs to the FIRST matching category only.

**Tiebreaker rule**: If a file path matches multiple categories at different directory depths:

1. Use the **deepest matching directory** (e.g., `src/main/services/ui/dialog.ts` → Backend/IPC because `services/` is deeper than `main/`)
2. If same depth, use priority order (lower number wins)

### Step 4: Map categories to review commands

Each file category gets reviewed by multiple specialized review commands:

| Category       | Review Commands                                  |
| -------------- | ------------------------------------------------ |
| Electron/Main  | `/review-code`, `/review-algorithm-architecture` |
| Backend/IPC    | `/review-code`, `/review-algorithm-architecture` |
| Frontend/UI    | `/review-code`, `/review-algorithm-architecture` |
| Config/Build   | `/review-code`                                   |
| Utility/Common | `/review-code`, `/review-algorithm-architecture` |

**Total review agents**: (Categories with files) × (Applicable review commands per category)

---

## Phase 1: Parallel Review

Spawn review subagents using the Task tool. **CRITICAL**: Use the exact Task() definition format.

### Review Command Descriptions

| Command                          | Focus                                                                    | Engine |
| -------------------------------- | ------------------------------------------------------------------------ | ------ |
| `/review-code`                   | Logical bugs, security issues, TypeScript best practices, error handling | Claude |
| `/review-algorithm-architecture` | File organization, module boundaries, performance on hot paths           | Claude |

### Spawn agents by category × review command

For each (category, review_command) pair where files exist, spawn a Task:

```
Task(
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED: opus for quality reviews
  description: "[REVIEW_COMMAND] for [CATEGORY] files",
  prompt: """
    Read 00-review-context.md for branch context and changed line ranges.

    You are running [REVIEW_COMMAND] on [CATEGORY] files.

    Review ONLY these files:
    [SPECIFIC FILE LIST FOR THIS CATEGORY]

    **SCOPE RESTRICTION**:
    Report issues on changed lines OR caused by the changes (e.g., broken callers, type mismatches).
    Do NOT report pre-existing issues unrelated to this PR.
    For issues outside changed lines, include a "Causal Link" explaining the connection.

    Changed line ranges: [FROM 00-review-context.md]

    Follow the [REVIEW_COMMAND] standards exactly. Focus on issues relevant to that review type.

    Output format for each finding:
    - File: path/to/file.ts
    - Line: 42
    - Severity: Critical|High|Medium|Low
    - Review Type: [REVIEW_COMMAND]
    - Causal Link: [required if outside changed lines]
    - Issue: [description]
    - Fix: [suggested fix]
  """
)
```

### Example agent spawning for a PR with Electron, Backend, and Frontend files:

```
# Electron/Main files → 2 agents
Task(..., description: "/review-code for Electron/Main files", ...)
Task(..., description: "/review-algorithm-architecture for Electron/Main files", ...)

# Backend/IPC files → 2 agents
Task(..., description: "/review-code for Backend/IPC files", ...)
Task(..., description: "/review-algorithm-architecture for Backend/IPC files", ...)

# Frontend/UI files → 2 agents
Task(..., description: "/review-code for Frontend/UI files", ...)
Task(..., description: "/review-algorithm-architecture for Frontend/UI files", ...)

Total: 6 parallel review agents
```

**Launch ALL Task() calls in a single message block for true parallelism.**

**IMPORTANT — WAIT FOR ALL AGENTS**:

- Do NOT use `run_in_background: true` for any Phase 1 review agent.
- Task() calls without `run_in_background` are blocking by default — they return only when the subagent finishes.
- **VERIFICATION CHECKPOINT**: Before starting Phase 2, you MUST count the number of Task() results you received. It MUST equal the total number of Task() calls you made. If any result is missing, DO NOT proceed — wait or re-spawn the missing agent.

---

## Phase 2: Combine & Deduplicate Results

**⛔ GATE CHECK**: Before starting Phase 2, verify you received results from ALL Task() agents spawned in Phase 1. Count: [N agents] = [total]. If any agent result is missing, DO NOT proceed. Log which agent(s) are missing and note it in the final report.

1. **Collect all subagent outputs** (from all review types)

2. **Scope filter**: Discard findings outside changed lines that lack a Causal Link. Pass others to validation.

3. **Deduplicate findings** across review types and categories:
   - Same file + same line range (within 5 lines) + similar issue = duplicate
   - Keep the more specific/actionable finding
   - Merge severity (take highest)
   - Preserve the review type that caught the issue

4. **Exclude previously-skipped issues**:
   - Read the "Skipped Issues" section from `00-review-context.md`
   - For each new finding, check if it matches a skipped issue (same file + overlapping line range + similar description)
   - If match found → exclude from validation (already determined not worth fixing)
   - This prevents re-validating the same low-priority issues every iteration

5. **Categorize remaining issues**:
   - 🔴 **Critical** - Must fix
   - 🟠 **High** - Should fix
   - 🟡 **Medium** - Consider fixing
   - 🟢 **Low** - Nice to have

6. **Create findings report** with all non-skipped issues (all severities), including which review type found each issue

7. **Severity escalation** (iterations 2+):
   - If an issue was marked "✅ Fix" in iteration N but reappears in iteration N+1:
     - Escalate severity by one level: Low → Medium → High → Critical
     - Add note: "⚠️ Persisted from iteration N - previous fix may have been incomplete"
   - This ensures recurring issues get higher priority attention

---

## Phase 3: Validation (All Severities)

Validate all issues that weren't excluded by the "Skipped Issues" list.

### Grouping strategy:

- Group findings by file
- One validation agent per file (handles all findings for that file)
- Maximum 10 validation agents total

```
Task(
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED: opus for accurate validation
  description: "Validate findings in [filename]",
  prompt: """
    Validate these findings for [FILE PATH]:

    [LIST OF 1-N FINDINGS FOR THIS FILE]

    **Changed line ranges**: [FROM 00-review-context.md]

    **SCOPE CHECK (first step)**: Issues on changed lines are in scope. For issues outside changed lines, validate the Causal Link - reject as 🚫 Out of Scope if it's just pre-existing tech debt unrelated to PR changes.

    For each IN-SCOPE finding:
    1. Read the actual code at the reported location
    2. Verify the issue actually exists
    3. Check if the suggested fix is correct
    4. Determine if it's worth fixing

    Mark each as:
    - ✅ **Fix** - Valid issue in changed code (default - when in doubt, fix it)
    - ⏭️ **Skip** - Valid but genuinely not worth fixing (RARE - see strict criteria below)
    - ❌ **False Positive** - Issue doesn't actually exist
    - 🚫 **Out of Scope** - Issue exists but is in pre-existing code not changed by this PR

    **STRICT Skip Criteria** - Only skip if ALL of these are true:
    1. The issue is purely cosmetic/stylistic with zero functional impact
    2. Fixing it would require changing >50 lines of unrelated code
    3. The pattern is consistently used throughout the codebase (not just this file)

    **DO NOT SKIP these issues (always fix):**
    - ❌ Silent error swallowing or empty catch blocks
    - ❌ Type coercion hacks (e.g., `as unknown as X`, `as any`)
    - ❌ Missing error handling or error messages
    - ❌ Redundant code, dead code, or unused variables
    - ❌ Security issues of any severity
    - ❌ Race conditions or async issues
    - ❌ Memory leaks or resource cleanup issues
    - ❌ Any issue in NEW code (code added in this PR)
    - ❌ IPC security issues (missing validation, exposed handlers)

    Examples of what CAN be skipped:
    - Pure naming preferences when existing codebase uses the same style
    - Adding JSDoc to functions that are already self-documenting
    - Reordering imports when not violating any lint rules

    For each Skip decision, provide:
    - File and line range
    - Severity level
    - Reason for skipping (must match one of the allowed skip criteria above)
    - Brief issue summary
  """
)
```

### After validation: Update Skipped Issues

For any issues marked as ⏭️ **Skip**, append them to the "Skipped Issues" section in `00-review-context.md`:

```markdown
## Skipped Issues (Do Not Re-validate)

<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

src/utils/helper.ts:42-45 | Low | Stylistic preference | Variable naming convention
```

**This ensures the same issues are not re-validated in subsequent iterations.**

**Out of Scope** issues are discarded (not tracked). Issues outside changed lines CAN be in scope if caused by PR changes.

### Early exit check

After validation completes, check if there are any actionable issues:

```
IF (all_issues_marked_FP_or_Skip):
    → Update Skipped Issues list in 00-review-context.md
    → Update Iteration State: "Last completed phase: Validation (no actionable issues)"
    → EXIT - No actionable issues found
    → Do NOT proceed to Phase 4
```

This prevents spawning fix agents when there's nothing to fix.

---

## Phase 4: Fix

**CRITICAL**: All fixes MUST be done via Task() subagents with opus. No direct edits.

### Step 1: Commit uncommitted changes first

```bash
git status --porcelain
# If output exists:
git add -A && git commit -m "WIP: Changes before auto-review fixes"
```

### Step 2: Build the fix manifest from validation output

**MANDATORY**: Create an explicit mapping from validation results to fix actions.

For every issue marked "✅ Fix" in validation:

1. Record: `[file] → [issue description] → [suggested fix]`
2. Group by file

**Traceability requirement**: Every "✅ Fix" issue MUST appear in the fix manifest. Do not:

- Skip issues because you believe a different fix "solves the root cause"
- Substitute your judgment for what validation explicitly said to fix
- Rationalize away issues as "will be handled by another fix"

If validation says "✅ Fix" for file X, spawn a fix agent for file X. Period.

### Step 3: Group validated issues by file

- Group up to **5 issues per fix agent** (within same file)
- If a file has >5 issues, split into multiple agents
- **Maximum 10 fix agents** per iteration
- If >10 files need fixes, prioritize by severity (Critical > High > Medium > Low)
- Defer lower-priority files to the next iteration

### Conflict prevention

To avoid race conditions when multiple agents edit overlapping code:

- Each file should have **at most ONE fix agent running at a time**
- If a file has >5 issues requiring multiple agents, spawn them **sequentially** (not in parallel)
- After each fix agent completes for a multi-agent file, verify the file is syntactically valid before spawning the next
- Update Iteration State after each agent completes: `Files fixed this iteration: [updated list]`

### Step 4: Spawn fix subagents

```
Task(
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED: opus for quality fixes
  description: "Fix issues in [filename]",
  prompt: """
    Fix the following validated issues in [FILE PATH]:

    Issue 1: [description]
    - Line: XX
    - Fix: [suggested fix]

    Issue 2: [description]
    - Line: YY
    - Fix: [suggested fix]

    [Up to 5 issues]

    Instructions:
    1. Read the file first
    2. Apply each fix using the Edit tool
    3. Verify fixes don't break syntax
    4. Report what was fixed
  """
)
```

### Step 5: Track changes

Record all files modified for the iteration summary.

### Step 5.5: Verify fixes don't break build

After all fix agents complete, run a type check:

```bash
npm run typecheck 2>&1
```

If the type check fails:

- Log which fix agent(s) likely caused the failure
- Continue to Phase 5 - the next iteration's review will catch the type errors as new issues
- Update Iteration State: `Build status: FAILED (type errors in [files])`

### Step 6: Verify fix manifest completeness

Before proceeding to Phase 5, verify:

- Every file in the fix manifest had a fix agent spawned
- Every "✅ Fix" issue from validation was addressed by a fix agent
- No issues were skipped due to assumptions about "root cause" fixes elsewhere

If any "✅ Fix" issue was not addressed, spawn additional fix agents now.

---

## Phase 5: Exit Conditions

**CRITICAL LOGIC**: You cannot exit with "no issues" immediately after fixing. Must confirm with another review.

```
IF (fixes_applied_this_iteration > 0):
    → MUST run another iteration to confirm fixes work
    → Cannot claim "no issues" without verification

IF (review_found_no_issues_to_fix AND fixes_applied_this_iteration == 0):
    → EXIT - Clean (all new findings either fixed or added to Skipped Issues)

IF (iteration >= 4):
    → EXIT - Max iterations reached

IF (same_issues_persist_for_2_iterations):
    → EXIT - Stuck in loop

OTHERWISE:
    → Continue to next iteration
```

**The key insight**: "I fixed all issues" ≠ "There are no issues". Another review round must confirm.

**Note on convergence**: The loop converges because:

1. Fixed issues no longer appear in subsequent reviews
2. Skipped issues are tracked and excluded from future validation
3. Only genuinely new issues trigger additional work

---

## Iteration Tracking

Display progress after each phase:

```
╔════════════════════════════════════════════════════════════╗
║  ITERATION 1/4                                             ║
╠════════════════════════════════════════════════════════════╣
║  Phase 0 - Setup:     ✅ Context file created              ║
║  Phase 1 - Review:    ✅ 6 agents across 2 review types    ║
║    /review-code:                 3 agents (all categories) ║
║    /review-algorithm-architecture: 3 agents                ║
║  Phase 2 - Combine:   ✅ 12 findings (3 out-of-scope, 0 skipped) ║
║  Phase 3 - Validate:  ✅ 8 fix, 2 skip, 1 out-of-scope, 1 FP ║
║  Phase 4 - Fix:       ✅ 8 issues fixed (opus)             ║
║  Phase 5 - Check:     🔁 Fixes applied → verify next round ║
║  Skipped Issues:      📝 2 added to tracking list          ║
╚════════════════════════════════════════════════════════════╝
→ Starting iteration 2 to verify fixes...
```

---

## Final Report

```
╔════════════════════════════════════════════════════════════╗
║  AUTO REVIEW-FIX COMPLETE                                  ║
╠════════════════════════════════════════════════════════════╣
║  Iterations completed: X/4                                 ║
║  Exit reason: [Clean review | Max iterations | Loop stuck] ║
║  Total issues found:   XX                                  ║
║  Out of scope:         XX (pre-existing code, not in PR)   ║
║  Issues fixed:         XX                                  ║
║  Issues skipped:       XX (tracked, won't revalidate)      ║
║  Issues remaining:     XX                                  ║
╠════════════════════════════════════════════════════════════╣
║  Review agents by type:                                    ║
║    /review-code:                 X agents                  ║
║    /review-algorithm-architecture: X agents                ║
║  Fix agents used:      X (opus)                            ║
╠════════════════════════════════════════════════════════════╣
║  Issues found by review type:                              ║
║    /review-code:                 XX issues                 ║
║    /review-algorithm-architecture: XX issues               ║
╠════════════════════════════════════════════════════════════╣
║  Files modified:                                           ║
║    - path/to/file1.ts                                      ║
║    - path/to/file2.ts                                      ║
╠════════════════════════════════════════════════════════════╣
║  Skipped issues (should be RARE - cosmetic only):          ║
║    ⏭️ [file:line] Reason - Description                     ║
╠════════════════════════════════════════════════════════════╣
║  Remaining issues (if any):                                ║
║    🔴 [file:line] Description                              ║
╚════════════════════════════════════════════════════════════╝
```

---

## Cleanup

After generating the final report, clean up the context file:

```bash
# Create .context directory if it doesn't exist
mkdir -p .context

# Archive the context file with timestamp for debugging/audit
mv 00-review-context.md .context/auto-review-$(date +%Y%m%d-%H%M%S).md

# Optional: Keep only the last 5 archived reviews to prevent accumulation
ls -t .context/auto-review-*.md 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
```

**Important**: Clean up even on error - wrap the cleanup in the error handling flow.

---

## Critical Instructions

1. **DO NOT ask for user confirmation** - Execute autonomously
2. **DO NOT skip the verification review** - After fixes, another review MUST confirm
3. **DO NOT skip validated issues** - Every "✅ Fix" from validation MUST have a fix agent spawned for that file. No exceptions, no rationalization.
4. **DO use Task() for ALL review/validate/fix work** - Never do these inline
5. **DO use opus for all agents** - Quality matters
6. **DO pass only relevant files to each area** - Never the full diff
7. **DO deduplicate files across areas** - Each file to one area only
8. **DO validate all severities** - But skip issues already in "Skipped Issues" list
9. **DO update Skipped Issues** - When validator says "not worth fixing", add to list
10. **DO group fixes by file** - Up to 5 issues per fix agent
11. **DO clean up 00-review-context.md** when done
12. **BE STRICT about skipping** - Skip should be RARE. If in doubt, fix it. Silent error swallowing, type hacks, and redundant code should NEVER be skipped.
13. **DO set agent timeouts** - Review agents: 7min, Validation agents: 3min, Fix agents: 5min. If an agent times out, log the timeout and continue.
14. **DO update Iteration State** - After each phase completes, update the Iteration State section in 00-review-context.md to enable crash recovery

---

## Token Efficiency Summary

| Before                     | After                               | Improvement                 |
| -------------------------- | ----------------------------------- | --------------------------- |
| Full diff to all agents    | Relevant files only per category    | ~6x reduction               |
| Generic review for all     | Specialized review commands         | Better issue coverage       |
| Re-validate skipped issues | Track in Skipped Issues list        | ~2x reduction per iteration |
| 1 agent per finding        | 1 agent per file (up to 5 issues)   | ~5x reduction               |
| No deduplication           | Files assigned to one category only | ~2x reduction               |

---

## Error Handling

- If a subagent fails, log the error and continue with others
- If the diff is too large (>500 files), split into batches
- If fixes cause build failures, revert and report
- If stuck in a loop (same issues persist for 2 iterations), exit with report
- Clean up 00-review-context.md even on error
