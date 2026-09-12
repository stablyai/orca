---
name: orca-code-search
description: >-
  Use Orca Unified Code Search (powered by ABS 3-tier discovery architecture:
  exact narrowing, BM25 lexical ranking, and local vector verification) for
  codebase exploration without token bleeding. Restricts agent to two MCP tools:
  'search' for intent-based discovery and 'rg' for exact symbol matching. Use
  when exploring monorepos, finding architectural patterns, avoiding repetitive
  ripgrep loops, and optimizing agent context windows in Orca worktrees.
---

# Orca Unified Code Search (`orca-code-search`)

This skill equips Orca ADE and coding agents with the **ABS Unified Code Search Engine**, delivering high-precision codebase discovery while cutting token consumption by ~95%.

## 1. Core Architecture (ABS 3-Tier Pipeline)

```text
[ Natural Language Query ] ("where is retry backoff logic configured?")
           │
           ▼
[ 1. Narrowing: ripgrep ]  ──► C-speed exact matching & AST pruning (>95% noise removed)
           │
           ▼
[ 2. Ranking: BM25 ]       ──► Lexical ranking via IDF * (TF / Norm) across candidates
           │
           ▼
[ 3. Verification: Vector] ──► Semantic reranking with in-process CPU vector embeddings
           │
           ▼
   [ Final Results ]       ──► 3–5 pinpointed code blocks (~300 tokens)
```

## 2. Restraint Design Invariants (Enforced Boundaries)

1. **Strict 2-Tool MCP Exposure:**
   - `search(query, path?, limit?)`: Use when searching with natural language intent but unknown identifiers.
   - `rg(pattern, path?, glob?)`: Use when searching with exact symbol names, functions, or regex patterns.
2. **Immutable Index:** Agents are **STRICTLY FORBIDDEN** from creating, updating, or deleting indexes mid-session. Indexing is managed via CLI or pre-commit hooks.
3. **Loopback Only:** All vector embeddings and search indexes run locally on `127.0.0.1`. No code leaves the developer machine.
4. **Zero GPU Dependency:** Default embedding runs on lightweight CPU ONNX runtimes with Node 22+.

## 3. Quickstart & Integration

### CLI Installation & Alias
```bash
npm install -g @zvec/zvec-grep

# Setup Orca CLI alias in ~/.zshrc or ~/.bashrc:
alias orca-search="zg query"
alias abs-search="zg query"
alias orca-index="zg index --embedding local/potion-code-16m-v2"
```

### Indexing the Current Workspace
```bash
cd /path/to/workspace
orca-index
```

### Agent Auto-Configuration
Run the managed installer to wire up Orca, Claude Code, Codex, and Cursor:
```bash
zg install
```

For specific agents:
```bash
zg install claude-code
zg install codex
zg install cursor
```

## 4. Usage Rules for Agents

- **DO NOT** use `search` when you already have the exact function or variable name; use `rg` instead to save compute.
- **DO NOT** loop through files reading raw contents when searching for an architecture pattern; execute one `search` call with clear intent first.
- If `search` returns results, inspect the provided snippet before deciding whether to read the full file.
