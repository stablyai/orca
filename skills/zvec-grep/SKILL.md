---
name: zvec-grep
description: >-
  Use unified 3-stage search (ripgrep exact narrowing, BM25 lexical ranking, and
  vector semantic verification) for codebase exploration without token bleeding.
  Restricts agent to two MCP tools: 'search' for intent-based discovery and 'rg'
  for exact symbol matching. Use when exploring large monorepos, locating unknown
  architecture components, avoiding iterative grep loops, or optimizing agent context.
---

# Unified Code Search with zvec-grep (`zg`)

This skill provides operational guidance, restraint boundaries, and automated setup for Alibaba's `zvec-grep` (`zg`) within Orca worktrees, Claude Code, and agent workspaces.

## 1. Core Architecture (The 3-Stage Pipeline)

```text
[ Natural Language Query ] ("where is retry backoff logic configured?")
           │
           ▼
[ 1. Narrowing: ripgrep ]  ──► Fast exact/regex C-speed filtering (>95% noise pruned)
           │
           ▼
[ 2. Ranking: BM25 ]       ──► Lexical scoring via IDF * (TF / Norm) across candidates
           │
           ▼
[ 3. Verification: Vector] ──► Semantic reranking with local CPU embedding (potion-code-16m-v2)
           │
           ▼
   [ Final Results ]       ──► 3–5 pinpointed code blocks (~300 tokens)
```

## 2. Restraint Design Invariants (Enforced Boundaries)

1. **Strict 2-Tool MCP Exposure:**
   - `search(query, path?, limit?)`: Use when searching with natural language intent but unknown identifiers.
   - `rg(pattern, path?, glob?)`: Use when searching with exact symbol names, functions, or regex patterns.
2. **Immutable Index:** Agents are **STRICTLY FORBIDDEN** from creating, updating, or deleting indexes mid-session. Indexing must be managed externally via pre-commit or CLI.
3. **Loopback Only:** All vector embeddings and search indexes run locally on `127.0.0.1`. No code leaves the developer machine.
4. **Zero GPU Dependency:** Default embedding runs on lightweight CPU ONNX runtimes with Node 22+.

## 3. Quickstart & Integration

### CLI Installation
```bash
npm install -g @zvec/zvec-grep
```

### Indexing the Current Workspace
```bash
cd /path/to/workspace
zg index --embedding local/potion-code-16m-v2
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
