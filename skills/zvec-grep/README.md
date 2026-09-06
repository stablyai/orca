# zvec-grep (`zg`): Unified Code Search Layer for Orca & Agents

`zvec-grep` integrates ripgrep, BM25, and vector search into a single high-performance CLI and MCP server designed specifically for humans and AI coding agents.

---

## 1. Why zvec-grep?

- **Eliminates Token Bleeding:** Conventional agents burn 15,000–45,000 tokens guessing keywords with ripgrep, reading irrelevant files, and stitching context manually. `zg` narrows, ranks, and verifies results in a single tool call, returning only the exact code blocks (~300 tokens).
- **Combines Exact Match + Semantic Intent:** Pure vector search fails on exact symbol lookups. Pure ripgrep fails on natural language intent. `zg` cascades both with BM25 lexical ranking in the middle.
- **Agent Restraint Principle:** Exposes only two read-only tools (`search` and `rg`). No hallucinated index manipulation.

---

## 2. Installation on Local Mac / Orca

### Prerequisites
- Node.js 22 or newer
- Ripgrep installed (`brew install ripgrep`)

### Install Command
```bash
npm install -g @zvec/zvec-grep
```

### Setup MCP in Orca / Claude Code
```bash
# Auto-detect and configure all installed agents
zg install
```

---

## 3. Workflow in Orca

1. **Initial Indexing (One-time per repo):**
   ```bash
   cd ~/your-project
   zg index --embedding local/potion-code-16m-v2
   ```

2. **Querying from Terminal:**
   ```bash
   # Natural language intent
   zg query "where theme preferences are restored"

   # Human-readable output
   zg query --human "plugin lifecycle" --limit 5
   ```

3. **Agent MCP Calls:**
   When working with Claude Code or Orca, the agent automatically utilizes:
   - `zvec_grep.search`: Intent exploration.
   - `zvec_grep.rg`: Regex/Exact match lookup.
