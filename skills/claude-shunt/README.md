# Spotify Shunt: PreToolUse Cognitive Routing & Token Optimization

This skill equips Orca with Spotify's Shunt mechanism for Claude Code and coding agents.

---

## 1. Executive Summary

- **Core Problem:** Frontier models (Claude 3.7 Sonnet / Opus) burn up to 90% of tokens reading raw monorepo boilerplate, giant classes, and log dumps.
- **Why Prompt Rules Fail:** System prompts or `CLAUDE.md` instructions asking the model to "be frugal" fail under cognitive pressure due to Attention Drift.
- **The Shunt Solution:** PreToolUse hooks enforce a hard token firewall at the runtime boundary, blocking reads > 350 lines and routing bulk I/O to low-cost workers (`bulk-reader`, `code-writer`).

---

## 2. Architecture Overview

```text
[Claude Code / Frontier Agent]
           │
           │ Tool Call: Read(file)
           ▼
   [ PreToolUse Hook ]
           │
     Lines > 350?
     ├── NO  ──► Direct Read (Pass-through)
     └── YES ──► HARD BLOCK ──► Delegate to Cheap Worker (Temp 0.2)
                                       │
                                       ├── Bulk-Reader: Structured Bullets back to Claude
                                       └── Code-Writer: Direct write to filesystem
```

---

## 3. Installation in Orca Worktree

```bash
# Add Spotify Portal marketplace
claude plugin marketplace add spotify/portal-ai-plugins

# Install core portal and shunt plugin
claude plugin install portal@portal
claude plugin install shunt@portal

# Run setup command
/portal:setup
```

---

## 4. Key Configurations

| Variable | Default | Description |
|---|---|---|
| `SHUNT_MIN_LINES` | `350` | Minimum line count triggering the PreToolUse block |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `haiku` | Sub-agent worker model for bulk reading |

---

## 5. Critical Invariants (What NOT to Delegate)

1. **Code Editing & Patching:** Summaries destroy line fidelity. Always keep patch reads direct via offsets.
2. **Subtle Logic & Concurrency:** Concurrency bugs hide in tiny details. Full context is mandatory for reasoning.
3. **Small Files (<= 350 lines):** Delegation overhead (10–30s) exceeds the token savings.
