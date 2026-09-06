---
name: claude-shunt
description: >-
  Use Spotify Shunt architecture and PreToolUse hooks for Claude Code and coding
  agents to cut token costs by ~90% on large files. Intercepts file reads exceeding
  350 lines (SHUNT_MIN_LINES) and delegates bulk reading to cheap worker models
  returning structured bullet summaries, while directing code generation to disk.
  Never delegates code editing/patching or deep subtle reasoning. Use when configuring
  token optimization, reducing LLM context burn in monorepos, installing spotify/portal-ai-plugins,
  or running bulk file analysis in Orca worktrees.
---

# Claude Shunt & Cognitive Routing (Spotify Architecture)

This skill provides operational guidance, installation workflows, and boundary enforcement for Spotify's Shunt token-saving plugin (`spotify/portal-ai-plugins`) running with Claude Code and AI agents within Orca worktrees.

## Core Mechanism: Enforcement Over Advisory

1. **Failure of `CLAUDE.md` rules:** LLMs under cognitive load or growing context suffer Attention Drift and ignore prompt-based token-saving recommendations.
2. **Deterministic PreToolUse Hooks:** Intercepts tool calls at the OS/Harness level before oversized content enters the context window.
   - `check-file-size`: Hard-blocks `Read` operations when lines exceed `SHUNT_MIN_LINES` (default: 350).
   - `check-bash-read`: Hard-blocks unbounded `cat`, `head`, `tail` on large files while allowing targeted pipes (`grep`, `awk`, `sed`).
3. **Dual Worker Delegation:**
   - **Bulk-Reader Mode:** Cheap worker (Temperature 0.2) summarizes thousands of lines into structured bullet points.
   - **Code-Writer Mode:** Generates boilerplate directly to disk, bypassing orchestrator context.

## Non-Delegation Boundaries (Strict Invariants)

- **NEVER delegate Code Editing / Patching:** Summarized text loses exact line numbers and whitespace, corrupting unified diffs.
- **NEVER delegate Deep Reasoning / Subtle Concurrency Bugs:** Aggressive summarization discards subtle edge-cases (thread safety, race conditions).
- **Latency Tradeoff:** Delegation round-trip incurs 10–30s latency. Never apply to files <= 350 lines or targeted slices.

## Quickstart & Installation

Run inside the terminal or target worktree:

```bash
# 1. Add Spotify Portal marketplace
claude plugin marketplace add spotify/portal-ai-plugins

# 2. Install Portal CLI and Shunt plugin
claude plugin install portal@portal
claude plugin install shunt@portal

# 3. Initialize inside Claude Code session
/portal:setup
```

## Environment Configuration

```bash
# Line threshold for hook interception (default 350)
export SHUNT_MIN_LINES=350

# Worker model for sub-agent exploration
export CLAUDE_CODE_SUBAGENT_MODEL=haiku
```
