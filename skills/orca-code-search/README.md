# Orca Unified Code Search (`orca-code-search`)
## Powered by ABS Unified Code Search Engine Architecture

`orca-code-search` embeds a local, 3-tier hybrid discovery layer directly into Orca ADE, uniting exact regex pruning, BM25 lexical ranking, and semantic vector verification into a unified workflow.

---

## 1. Why Orca Code Search?

- **Eliminates Token Bleeding:** Conventional agents burn 15,000–45,000 tokens guessing keywords with ripgrep, reading irrelevant files, and stitching context manually. Orca Code Search narrows, ranks, and verifies results in a single tool call, returning only the exact code blocks (~300 tokens).
- **Combines Exact Match + Semantic Intent:** Pure vector search fails on exact symbol lookups. Pure ripgrep fails on natural language intent. This architecture cascades both with BM25 lexical ranking in the middle.
- **Agent Restraint Principle:** Exposes only two read-only tools (`search` and `rg`). No hallucinated index manipulation.

---

## 2. Installation on Local Mac / Orca ADE

### Prerequisites
- Node.js 22 or newer
- Ripgrep installed (`brew install ripgrep`)

### Install Command
```bash
npm install -g @zvec/zvec-grep

# Setup Orca CLI alias:
echo 'alias orca-search="zg query"' >> ~/.zshrc
echo 'alias abs-search="zg query"' >> ~/.zshrc
echo 'alias orca-index="zg index --embedding local/potion-code-16m-v2"' >> ~/.zshrc
source ~/.zshrc
```

### Setup MCP in Orca / Claude Code
```bash
# Auto-detect and configure all installed agents
zg install
```

---

## 3. Workflow in Orca ADE

1. **Initial Indexing (One-time per repo):**
   ```bash
   cd ~/your-project
   orca-index
   ```

2. **Querying from Terminal:**
   ```bash
   # Natural language intent
   orca-search "where theme preferences are restored"

   # Human-readable format
   orca-search --human "plugin lifecycle" --limit 5
   ```

3. **Agent MCP Calls:**
   When working with Claude Code, Codex, or Orca agents, the agent automatically utilizes:
   - `search`: Intent exploration and semantic discovery.
   - `rg`: Exact symbol and regex match lookup.
