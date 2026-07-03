---
name: safe-dispatch
description: >-
  3-gate validation for dispatching agents to Orca worktrees: resolve the
  handle live, validate no collision, then dispatch. Prevents wrong-worktree
  dispatch, double-agent collisions, and stale-handle bugs. Includes an
  inbox monitor pattern for reliable message consumption. Complements the
  orchestration skill with safety guardrails.
---

# Safe Dispatch

A safety layer on top of Orca orchestration that prevents the three most common dispatch bugs:

1. **Wrong-worktree dispatch** from cached or stale handles
2. **Double-agent collision** from dispatching into an occupied worktree
3. **Lost messages** from multiple inbox consumers

Every dispatch runs all three gates in order. Skipping a gate is how wrong-worktree dispatch happens.

## Gate 1: RESOLVE (fresh, never cached)

Query live state. Never cache handles, never hold them in bash arrays (arrays caused wrong-worktree dispatches in practice):

```bash
orca worktree ps --json
```

Take the target worktree's full id (`repo::path` format, not the instanceId). If the worktree does not exist yet:

```bash
orca worktree create --name <slug> --no-parent --json
```

## Gate 2: VALIDATE (no double-dispatch)

Check the resolved worktree has no active agent (`state=working`). If one is working, stop and report; do not dispatch.

```bash
ACTIVE=$(orca worktree ps --json | jq '[.result.worktrees[] | select(.displayName == "TARGET") | .agents[] | select(.state == "working")] | length')
if [ "$ACTIVE" -gt 0 ]; then
  echo "BLOCKED: worktree has $ACTIVE active agent(s)"
  exit 1
fi
```

Two agents editing the same files means corruption. This gate is not optional.

## Gate 3: DISPATCH (fresh terminal, inject)

Create a fresh agent terminal, wait for it to be ready, then dispatch:

```bash
orca terminal create --worktree <full-id> --title <role> --command "<agent-command>" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 120000 --json
orca orchestration task-create --spec "<brief with inbox handle>" --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

The task spec should include the inbox handle so the worker can report back:

```
orca orchestration send --to <inbox_handle> --subject '<role> result' --body '<result>' --type status --json
```

## Inbox Monitor

A single persistent consumer for orchestration messages. Two consumers on the same inbox means lost messages (`check --wait` marks messages read on retrieval).

Run via Claude Code's Monitor tool (or any persistent process supervisor):

```bash
#!/usr/bin/env bash
# The ONE inbox consumer. Each stdout line becomes an instant notification.
# Full message bodies are saved to the store directory.
#
# NEVER run a second instance. check --wait marks messages read.
set -u

STORE="${ORCA_INBOX_STORE:-$HOME/.orca-inbox}"
mkdir -p "$STORE"

# Resolve inbox handle from env or from a named terminal
INBOX="${ORCA_INBOX:-}"
if [ -z "$INBOX" ]; then
  INBOX=$(orca terminal list --json 2>/dev/null \
    | jq -r '[.result.terminals[] | select(.title == "inbox")] | .[0].handle // empty')
fi
if [ -z "$INBOX" ]; then
  echo "ERROR: no inbox handle. Set ORCA_INBOX or create an inbox terminal."
  exit 1
fi

TMPF="$STORE/.check-result.json"

while true; do
  orca orchestration check \
    --terminal "$INBOX" --wait \
    --types status,worker_done,escalation,decision_gate \
    --timeout-ms 300000 --json > "$TMPF" 2>/dev/null

  COUNT=$(jq -r '.result.count // 0' "$TMPF" 2>/dev/null)
  if [ "$COUNT" -gt 0 ]; then
    jq -c '.result.messages[]' "$TMPF" 2>/dev/null | while IFS= read -r msg; do
      MSG_ID=$(echo "$msg" | jq -r '.id')
      echo "$msg" | jq '.' > "$STORE/$MSG_ID.json"
      SUBJ=$(echo "$msg" | jq -r '.subject')
      TYPE=$(echo "$msg" | jq -r '.type')
      BODY_SHORT=$(echo "$msg" | jq -r '.body | gsub("\n";" / ") | .[0:150]')
      echo "[$TYPE] $SUBJ: $BODY_SHORT (full: $STORE/$MSG_ID.json)"
    done
  fi
done
```

## Safe Dispatch Script

A standalone script that enforces all 3 gates:

```bash
#!/bin/bash
# Usage: safe-dispatch.sh <worktree-name> <role> <prompt> [inbox-handle] [agent-command]
#
# Examples:
#   safe-dispatch.sh feature-3 fixer "Fix the CSS transition" term_xxx
#   safe-dispatch.sh feature-3 builder "Build the component" term_xxx "codex"

WORKTREE_NAME="$1"
ROLE="$2"
PROMPT="$3"
INBOX="${4:-$INBOX}"
AGENT_CMD="${5:-codex}"

if [ -z "$WORKTREE_NAME" ] || [ -z "$ROLE" ] || [ -z "$PROMPT" ]; then
  echo '{"ok":false,"error":"usage: safe-dispatch.sh <worktree> <role> <prompt> [inbox] [agent-cmd]"}'
  exit 1
fi

# GATE 1: RESOLVE
WT_INFO=$(orca worktree ps --json 2>&1 \
  | jq -r ".result.worktrees[] | select(.displayName == \"$WORKTREE_NAME\")")
if [ -z "$WT_INFO" ]; then
  echo "{\"ok\":false,\"gate\":\"resolve\",\"error\":\"worktree '$WORKTREE_NAME' not found\"}"
  exit 1
fi
BRANCH=$(echo "$WT_INFO" | jq -r '.branch')

# GATE 2: VALIDATE
ACTIVE_AGENTS=$(echo "$WT_INFO" | jq '[.agents[] | select(.state == "working")] | length')
if [ "$ACTIVE_AGENTS" -gt 0 ]; then
  echo "{\"ok\":false,\"gate\":\"validate\",\"error\":\"worktree has $ACTIVE_AGENTS active agent(s)\"}"
  exit 1
fi

# GATE 3: DISPATCH
TERM_RESULT=$(orca terminal create \
  --worktree "name:$WORKTREE_NAME" --title "$ROLE" --command "$AGENT_CMD" --json 2>&1)
HANDLE=$(echo "$TERM_RESULT" | jq -r '.result.terminal.handle // .result.handle // empty')
if [ -z "$HANDLE" ]; then
  echo "{\"ok\":false,\"gate\":\"dispatch\",\"error\":\"failed to create terminal\"}"
  exit 1
fi

orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms 120000 --json > /dev/null 2>&1

FULL_PROMPT="You are a $ROLE working on $WORKTREE_NAME (branch: $BRANCH). $PROMPT"
if [ -n "$INBOX" ]; then
  FULL_PROMPT="$FULL_PROMPT

When done, report: orca orchestration send --to $INBOX --subject '$ROLE result: $WORKTREE_NAME' --body 'YOUR_RESULT' --type status --json"
fi

TASK_ID=$(orca orchestration task-create --spec "$FULL_PROMPT" --json 2>&1 | jq -r '.result.task.id')
DISPATCH_OK=$(orca orchestration dispatch --task "$TASK_ID" --to "$HANDLE" --inject --json 2>&1 | jq -r '.ok')

echo "{\"ok\":$DISPATCH_OK,\"worktree\":\"$WORKTREE_NAME\",\"role\":\"$ROLE\",\"branch\":\"$BRANCH\",\"handle\":\"$HANDLE\",\"task\":\"$TASK_ID\"}"
```

## Anti-patterns

- **Never cache terminal handles.** They go stale. Always resolve live from Orca.
- **Never use bash arrays for handle mapping.** Off-by-one causes wrong-worktree dispatch.
- **Never dispatch without checking active agents.** Two agents editing the same files means corruption.
- **Never rely on terminal titles for identity.** Agents rename them.
- **Never run multiple consumers on the same inbox.** Messages get marked read on retrieval; two consumers means lost messages.
