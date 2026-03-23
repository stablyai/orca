---
name: auto-submit
description: End-to-end autonomous pipeline that runs auto-review-fix, then auto-pr-merge
---

# auto-submit

Autonomous pipeline: review+fix code, then create PR and merge. **Execute without user confirmation.**

## Steps

### 1. Auto Review-Fix

**IMPORTANT**: Run auto-review-fix as a sub-agent (not an inline skill) to ensure it gets its own isolated context window. This prevents instruction dilution and ensures fix phases properly spawn their own Task() sub-agents as required.

```
Agent(
  subagent_type: "general-purpose",
  description: "Run auto-review-fix",
  prompt: "Run the /auto-review-fix skill. Follow ALL instructions exactly, especially: all fixes MUST be done via Task() subagents with opus-4-5. No direct edits."
)
```

Wait for the agent to complete. Then commit any changes:

```bash
if [ -n "$(git status --porcelain)" ]; then
    git add -A && git commit -m "fix: address auto-review findings"
fi
```

**Continue to Step 2 — do not stop here.**

### 2. Auto PR-Merge

```
Use the Skill tool: skill: "auto-pr-merge"
```

Handles PR creation, CI polling, fix loops, and merge with `--admin --squash`.

## Rules

- Execute autonomously — no user confirmation
- Both steps run sequentially — do not stop between them
- Commit changes between steps
- If Step 1 fails catastrophically, stop (don't create a broken PR)
- If Step 2 fails, report the error with PR URL if available
