# Orca Dev Server Agent — Technical Design Documents

**Cập nhật:** 2026-07-30 (v3.1 — thêm TDD-AG-12 ProfileAwareAgentSpawner + TDD-AG-13 External API Connectors)
**Phiên bản:** v3.1 (AI Agent CLIs + External API Connectors fully documented)
**Source code:** `src/relay/agent-*.ts` + `src/shared/agent-wire-protocol.ts`
**HLD Ref:** C3.8 (Agent WebSocket System), C4.5, ADR-005
**HLD Reference:** [dev-server-architecture.md](../../../docs/hld/dev-server-architecture.md) | [HLD v1 C3](../../../docs/hld/v1/C3-components.md) | [HLD v1 C4](../../../docs/hld/v1/C4-code.md)
**Build:** `pnpm run build:relay` → `out/relay/agent.js`

> ⚠️ **v2.1 Migration**: Code agent KHÔNG còn ở `deploy/dev/agent/agent.js` (CommonJS, standalone).  
> Agent được tích hợp vào `src/relay/` (TypeScript, esbuild bundled), dùng chung tech stack với relay daemon.

---

## Tech Stack (chung với Backend)

| Layer | Technology |
|-------|-----------|
| Language | **TypeScript strict** (không còn CommonJS JS) |
| Runtime | **Node.js ≥ 22** (target: `node22`) |
| Bundler | **esbuild** (build-relay.mjs) → single-file CJS bundle |
| Module | CommonJS bundle (same as relay daemon) |
| Testing | **Vitest** (same as backend: `config/vitest.config.ts`) |
| Type check | `tsc --noEmit -p config/tsconfig.node.json` |
| Wire protocol | `src/shared/agent-wire-protocol.ts` (shared với server) |
| WebSocket | `ws` npm package (same as relay) |

---

## Source Location

```
src/
├── shared/
│   └── agent-wire-protocol.ts          ← Constants, types (AGENT_KEEPALIVE_INTERVAL_MS, etc.)
│
└── relay/                              ← Agent code lives here (same as relay daemon)
    ├── agent-entry.ts                  ← [MODIFY] Entry point (was agent.js)
    ├── agent-config.ts                 ← [NEW] Config từ env vars (typed)
    ├── agent-connection-direct.ts      ← [NEW] direct-websocket mode
    ├── agent-connection-relay.ts       ← [NEW] relay-websocket mode
    ├── agent-session.ts                ← [NEW] Session handler, handshake, keepalive
    ├── agent-wire.ts                   ← [NEW] encodeFrame/decodeFrame (typed)
    ├── agent-tool-registry.ts          ← [NEW] Tool definitions, discoverTools()
    ├── agent-exec-handler.ts           ← [EXTEND] runCommandCapture (already exists!)
    ├── agent-rpc-dispatch.ts           ← [NEW] JSON-RPC dispatcher
    ├── agent-credential-store.ts       ← [NEW] AI credential AES-256-GCM store
    ├── git-handler.ts                  ← [NEW] git.exec + git.execStream (whitelisted)
    ├── fs-handler-file-read.ts         ← [REUSE] Already exists
    ├── fs-handler-list-files.ts        ← [REUSE] Already exists
    └── fs-handler-rg-availability.ts  ← [REUSE] Already exists
```

---

## Build Output

```
out/relay/
├── agent.js        ← Bundled agent binary (esbuild CJS, standalone)
├── relay.js        ← Relay daemon (existing)
└── ...

Deploy to dev server:
scp out/relay/agent.js user@devserver:/home/ubuntu/orca-agent/
node /home/ubuntu/orca-agent/agent.js
```

---

## TDD Index

| TDD | Domain | HLD Ref | ADR | Status |
|-----|--------|---------|-----|--------|
| [TDD-AG-01](./01-architecture.md) | Architecture & Process Model (v2.1) | C3.8, C4.5 | ADR-005 | 🔄 Updated |
| [TDD-AG-02](./02-wire-protocol.md) | Binary Wire Protocol — shared types | C3.8 | ADR-005 | 🔄 Updated |
| [TDD-AG-03](./03-connection-modes.md) | Connection Modes — TypeScript classes | C3.8 | ADR-004 | 🔄 Updated |
| [TDD-AG-04](./04-handshake-session.md) | Handshake — shared agent-wire-protocol | C3.8 | ADR-005 | 🔄 Updated |
| [TDD-AG-05](./05-tool-registry.md) | Tool Registry & Discovery (typed) | C3.8 | — | 🔄 Updated |
| [TDD-AG-06](./06-tool-handlers.md) | Tool Handlers — extend agent-exec-handler.ts | C3.8 | — | 🔄 Updated |
| [TDD-AG-07](./07-jsonrpc-dispatch.md) | JSON-RPC Dispatch & MCP Protocol | C3.8 | ADR-005 | 🔄 Updated |
| [TDD-AG-08](./08-deployment.md) | Deployment — esbuild + systemd | C3.8 | ADR-004 | 🔄 Updated |
| [TDD-AG-09](./09-ai-credential-relay.md) | AI Credential Store (v5.0) | C3.11a | ADR-008 | 🚧 In-Progress |
| [TDD-AG-10](./10-git-handler-extension.md) | Git Handler (v5.0) — extends git-handler.ts | C3.12 | ADR-012 | 🚧 In-Progress |
| [TDD-AG-11](./11-fs-handler-extension.md) | FS Handler (v5.0) — extends fs-handler-*.ts | C3.12 | ADR-011 | 🚧 In-Progress |
| [TDD-AG-12](./12-agent-spawner.md) | ProfileAware Agent Spawner — AI Agent CLI Host | C3.9, C3.11 | ADR-009 | 🚧 In-Progress |
| [TDD-AG-13](./13-external-api-connectors.md) | External API Connectors — GitHub & GitLab | C3.12 | ADR-012 | 🚧 In-Progress |

> **RPC surface — current source of truth:** the tables above (esp. TDD-AG-07,
> 10, 11) describe the original v5.0 method set at design time. The RPC
> surface has grown substantially since (`fs.stat`/`fs.glob`/`fs.writeFile`/
> `fs.mkdir`/`fs.rmdir`, `git.history`/`branchCompare`/`commitCompare`/
> `branchDiff`/`commitDiff`/`checkIgnored`/`forkSync`/`submoduleStatus`/
> `worktree.*`, `shell.exec`, `notification.send`, `preflight.*`, `ai.*`,
> `github.*`/`gitlab.*`, `pty.*`, and more), and — critically — the agent runs
> **two independently-registered RPC surfaces** (a direct-WebSocket dispatch
> table and a separate SSH-relay dispatcher), which these TDDs don't
> distinguish. For an exhaustive, code-verified catalog of every method
> either side of the backend↔agent connection exposes, see
> [`specs/agent/api/`](../../api/README.md) — generated 2026-08-15 by reading
> current source directly, with `file:line` citations and a dedicated
> [`gaps-and-findings.md`](../../api/gaps-and-findings.md) tracking drift
> between this TDD set and the real surface.

---

## Addendum A: v5.0 HLD Cross-References (2026-07-30)

> **Nguồn:** [dev-server-architecture.md](../../../docs/hld/dev-server-architecture.md), [HLD v1 C3](../../../docs/hld/v1/C3-components.md), [HLD v1 C4](../../../docs/hld/v1/C4-code.md)

### A.1 Dev Server Agent — Vai trò trong hệ thống (từ HLD §2)

| Vai trò | Mô tả |
|---------|-------|
| **Execution Environment** | AI agents thực sự chạy ở đây (Claude, Codex, Gemini) qua PTY |
| **Code Host** | Chứa git repositories và worktrees thực tế |
| **File System Provider** | Cung cấp file tree, file content, file search cho UI |
| **Git Operations Host** | Thực thi `git status/diff/add/commit/push/pull/pr create` |
| **AI Credential Store** | Lưu credential dạng AES-256-GCM (`~/.orca/ai-providers/<id>.enc`) |
| **Workflow Step Executor** | Thực thi từng step trong workflow (agent, shell, action) |
| **Health Reporter** | Báo CPU%, RAM, disk, network latency về Gateway mỗi 60s |
| **AI Agent CLI Host** | Spawn AI agent CLIs trực tiếp trên máy (ProfileAwareAgentSpawner) |
| **External API Caller** | Gọi GitHub/GitLab API qua `gh`/`glab` CLI với per-user auth |

### A.2 Agent Startup Sequence (từ HLD §3b)

```
orca-agent start
  │
  ├─ 1. Load config (/etc/orca-agent/config.yaml)
  │        GATEWAY_URL, AGENT_TOKEN, CREDENTIAL_KEY, LOG_LEVEL
  │
  ├─ 2. Init local SQLite (run migrations)
  │        Tables: agent_sessions, worktrees_local, audit_log_local
  │
  ├─ 3. Start Health Reporter
  │        Emit metrics every 60s: { cpu, ram, disk, latencyMs }
  │
  ├─ 4. Start RPC Server (internal — localhost only)
  │        Listen on Unix socket or localhost:PORT
  │
  ├─ 5. Connect to Gateway (outbound WS — Mode 3: direct-websocket)
  │        wss://orca-gateway:6768/agent
  │
  ├─ 6. Perform handshake (capabilities advertisement)
  │        Agent → { type: 'agent.handshake', agentToken, name, version, capabilities }
  │        Orca  → { type: 'handshake-ok', sessionId }
  │
  ├─ 7. Start emitting health events every 60s
  │        'fleet.health.updated' { serverId, cpu, ram, disk, latencyMs }
  │
  └─ 8. Ready to receive RPC calls
        ReconnectManager: exponential backoff 5s → 60s max
```

### A.3 Wire Protocol Format (từ HLD §5, TDD-AG-02)

```
┌─────────────────────────────────────────────────────────────┐
│ TYPE[1B] | SEQ[4B BE] | ACK[4B BE] | LEN[4B BE] | PAYLOAD  │
└─────────────────────────────────────────────────────────────┘
        = 13 bytes header total
PAYLOAD  = UTF-8 JSON-RPC 2.0
TYPE     = 0x01 Regular | 0x09 KeepAlive (every 30s)
```

### A.4 3 Connection Modes (từ HLD §4, TDD-AG-03)

| Mode | Initiator | Transport | Auth | Use case |
|------|----------|----------|------|---------|
| `relay-ssh` | Gateway | SSH exec channel | SSH key | Classical SSH remote host |
| `relay-websocket` | Gateway | `ws://agent:PORT/orca-relay` | Bearer token | Agent có public WS endpoint |
| `direct-websocket` | **Agent** | `wss://backend:6768/agent` | agentToken | **Default v6** — agent chủ động ra ngoài |

### A.5 Security Model (từ HLD §6)

| Điểm bảo mật | Cơ chế |
|--------------|--------|
| **Auth** | Bearer token raw → SHA-256 → stored hash so sánh |
| **Context integrity** | `RpcExecutionContext` HMAC-SHA256 signed, TTL 30s |
| **Credential relay** | Browser SubtleCrypto → SSH relay → Agent decrypt — **Gateway không thấy plaintext** |
| **File path safety** | `SecureFs.validatePath()` enforce `projectRoot` + `allowedRoots` |
| **User isolation** | `GH_CONFIG_DIR` per userId, PTY ownership check |
| **Shell safety** | `execFile()` (không dùng shell), `disallowedCommands` whitelist |
| **Audit** | Mọi RPC call logged với `userId + outcome` |

### A.6 AI Agent CLI Host — ProfileAwareAgentSpawner (từ HLD §11)

```
Gateway RPC: agent.spawn({ model, trustPreset, env, cwd, initFile })
    │
    ▼ ProfileAwareAgentSpawner
    │
    ├── Validate: model ∈ resolvedProfile.agent.approvedModels
    │
    ├── AiCredStore.get(accountId)
    │     → ~/.orca/ai-providers/<accountId>.enc → AES-256-GCM decrypt
    │
    ├── Build agent env:
    │     ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY (từ AiCredStore)
    │     ANTHROPIC_MODEL=claude-opus-4-5
    │     GH_CONFIG_DIR=~/.config/gh/<userId>/
    │     PATH=/custom/bin:$PATH (từ profile.shell.pathAdditions)
    │     ORCA_PROJECT_ID, ORCA_TASK_ID, ORCA_USER_ID
    │
    ├── node-pty.spawn(agentBinary, args, { cwd, env })
    │     Supported agents:
    │       claude   --trust standard   (Claude Code)
    │       codex    --model gpt-4o     (OpenAI Codex)
    │       gemini   --model gemini-2.0  (Gemini CLI)
    │       opencode                    (OpenCode)
    │       <custom binary>             (any compatible agent)
    │
    ├── OSC sequence parsing → state machine:
    │     idle → running → waiting_for_input → completed
    │
    ├── Emit: agent.statusChanged → EventBus → Gateway → Browser
    └── PTY output stream → Gateway → Browser terminal display
```

### A.7 External APIs từ Dev Server (từ HLD §12)

#### GitHub (Category A — CLI-based)

```
GitEngine.createPR(title, body, base)
    │
    ├── GH_CONFIG_DIR=~/.config/gh/<userId>/
    ├── execFile('gh', ['pr', 'create', '--title', title, ...])
    │       → HTTPS api.github.com/graphql (gh CLI handles auth)
    └── Returns: PR URL → stream to Gateway → update Task.prUrl

gh CLI operations:
  gh pr create / view / merge
  gh issue list / create / close
  gh repo clone / fork
  gh auth status   (dùng trong preflight check)
```

#### GitLab (Category A — CLI-based)

```
GLAB_CONFIG_DIR=~/.config/glab-cli/<userId>/
execFile('glab', ['mr', 'create', ...])
  → HTTPS gitlab.com API (glab CLI handles auth)
```

#### AI Provider APIs (qua credentials lưu local)

```
claude  → api.anthropic.com     (ANTHROPIC_API_KEY từ AiCredStore)
codex   → api.openai.com        (OPENAI_API_KEY từ AiCredStore)
gemini  → generativelanguage.googleapis.com (GOOGLE_API_KEY từ AiCredStore)
Ollama  → http://localhost:11434 (không cần key)
vLLM    → http://localhost:8000  (custom endpoint)
```

#### Preflight Check (Dev Server → External)

```
relay.call('preflight.check')
    │
    ▼ Dev Server thực thi:
    ├── gh auth status    (GH_CONFIG_DIR=~/.config/gh/<userId>/)
    ├── glab auth status
    ├── node --version
    └── disk space check
    │
    ▼ Results → stream về Gateway
    ▼ Gateway mergePreflightStatuses(localResults, relayResults)
         relay results OVERRIDE local (relay is authoritative for CLI tools)
```

### A.8 Agent Isolation Model (từ HLD §7)

| Mechanism | Cách thực hiện |
|-----------|----------------|
| PTY ownership | `ptyId` bound to `userId`, router checks ownership |
| File path | `SecureFs.validatePath()` checks `projectRoot` + `allowedRoots` |
| Git author | Injected từ `ctx.userEmail`, không thể bị override |
| AI env | `GH_CONFIG_DIR` per userId (isolated GitHub CLI config) |
| Shell commands | `execFile()` (no shell), `disallowedCommands` whitelist |
| Audit | All RPC calls logged với `userId + outcome` |

### A.9 AI Credential AES-256-GCM Flow (từ HLD §9 + TDD-AG-09)

```
RULE: Orca Backend Server KHÔNG BAO GIỜ thấy plaintext API key

Flow:
    Browser (CredentialInput)
        ↓ SubtleCrypto.encrypt(sessionKey, apiKey)    ← client-side
        ↓ POST /rpc { method: 'ai-providers.rotateKey', encryptedKey }
        ↓
    Orca Backend (KHÔNG decrypt — chỉ forward)
        ↓ relay.call('aiProvider.writeCredential', encryptedBlob)
        ↓ SSH tunnel / WS → Dev Server
        ↓
    Dev Server Agent (AiCredStore)
        ↓ AES-256-GCM decrypt (ORCA_AI_CREDENTIAL_KEY env)
        ↓ Write ~/.orca/ai-providers/<accountId>.enc
        ↓ chmod 0600

Read flow (khi spawn agent):
    ProfileAwareAgentSpawner.getCredential(accountId)
        → fs.readFile(~/.orca/ai-providers/<accountId>.enc)
        → AES-256-GCM decrypt → plaintext API key in memory
        → inject as ANTHROPIC_API_KEY / OPENAI_API_KEY env var
        → spawn agent process
        → key NOT stored in process after spawn
```

### A.10 Git Handler Full Command Set (từ HLD + TDD-AG-10)

```typescript
// git-handler.ts (agent-side) — whitelisted commands:
'git.status'        → exec('git status --porcelain=v2 --branch', { cwd })
'git.diff'          → exec('git diff [--staged] [--] [file]', { cwd })
'git.add'           → exec('git add <files>', { cwd })
'git.restore'       → exec('git restore [--staged] <files>', { cwd })
'git.commit'        → exec(`git commit -m "${msg}" --author="${name} <${email}>"`, { cwd })
'git.push'          → execStream('git push origin <branch>', { cwd })
'git.pull'          → execStream('git pull origin <branch>', { cwd })
'git.fetch'         → exec('git fetch --all --prune', { cwd })
'git.branch.list'   → exec('git branch -a -vv', { cwd })
'git.branch.create' → exec('git checkout -b <name> [from]', { cwd })
'git.branch.delete' → exec('git branch -d <name>', { cwd })
'git.merge'         → exec('git merge --no-ff <branch>', { cwd })
'git.stash'         → exec('git stash push -m <msg>', { cwd })
'git.stash.pop'     → exec('git stash pop', { cwd })
'git.log'           → exec('git log --oneline --graph --decorate -50', { cwd })
'git.pr.create'     → execFile('gh', ['pr', 'create', ...])  ← gh CLI
'git.worktree.list' → exec('git worktree list --porcelain', { cwd })
'git.worktree.add'  → exec('git worktree add <path> <branch>', { cwd })

// execStream protocol:
// { type: 'stdout', data: string }
// { type: 'stderr', data: string }
// { type: 'progress', pct: 0..100 }
// { type: 'done', exitCode: number }
```

### A.11 FS Handler Full Method Set (từ HLD + TDD-AG-11)

```typescript
// fs-handler-*.ts (agent-side):
'fs.readDir'   params: { path, depth: 1 }
               → fs.readdir(path) + fs.stat(entry) per child
               → return: FileEntry[] (name, path, isDir, size, mtime)
               → LIMIT: depth max 3

'fs.readFile'  params: { path, encoding: 'utf-8' }
               → SecureFs.validatePath(path, ctx.projectRoot)
               → fs.readFile(path, 'utf-8')
               → LIMIT: 5MB max

'fs.stat'      params: { path }
               → fs.stat(path) → { size, mtime, isDir, isFile }

'fs.glob'      params: { pattern, cwd, ignore?: string[] }
               → glob(pattern, { cwd, ignore })
               → return: string[] (relative paths)

'fs.grep'      params: { pattern, cwd, include?: string, maxResults?: number }
               → execFile('grep', ['-rn', '--include=<ext>', pattern, cwd])
                 OR ripgrep (rg) if available
               → LIMIT: 30 results max
               → return: GrepResult[] { file, line, content, match }

// SecureFs.validatePath():
// → path.resolve(requestedPath) must startWith projectRoot OR allowedRoots
// → Reject: '../', symlinks outside root, /etc, /proc, /sys
```

### A.12 Feature → Dev Server Component Mapping (từ HLD §13)

| Feature | Gateway Component | Dev Server Component |
|---------|------------------|---------------------|
| F01 Parallel Worktrees | ProjectService (quota, RBAC) | WorktreeEngine |
| F02 Terminal Splits | WsSessionRouter (routing) | PtyManager |
| F04 AI Agent Support | ProfileResolver + ProviderResolver | **ProfileAwareAgentSpawner + AI Agent CLIs** |
| F06 GitHub/Linear | WebCredentialStore (tokens) | **GitEngine (gh CLI → GitHub API)** |
| F12 File Explorer | — (proxy) | FsEngine |
| F27 Fleet Health | FleetHealthMonitor (aggregate) | HealthReporter |
| F28 Dev Server Onboard | DevServerProvisioner | First-connect bootstrap |
| F30 Remote Integrations | WebCredentialStore | **GitEngine (gh/glab auth isolation)** |
| F34 Project Binding | ProjectService | ContextVerifier (enforce) |
| F35 AI Provider Mgmt | AIProviderService (meta only) | **AiCredStore + AI Provider APIs** |
| F36 Workflow Orchestration | WorkflowOrchestrator (DAG, dispatch) | **StepExecutor + AI Agent CLIs** |
| F37 Task Graph | TaskService (grant, plan) | **ProfileAwareAgentSpawner + AI Agent CLIs** |
| F38 Project Workspace | WorkspaceContext | FsEngine + GitEngine |
| F39 Remote Git UI | — (proxy) | **GitEngine (gh CLI → GitHub/GitLab API)** |


---

## Addendum B (2026-09-07) - Corrections found during CR-STORAGE-00x agent-side audit

Two claims in section A.1/A.2 above do not match the real, current
`agent/src/relay/` source. Found and verified while executing
`specs/agent/crs/v3/storage/tasks/TASK-AG-STORAGE-002-verify-health-reporter-cadence.md`;
full detail in
`specs/agent/crs/v3/storage/solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md`.

1. **"Health Reporter" (A.1's role table, A.2 step 7, A.7's reference) does
   not exist as an agent-push mechanism.** Two independent
   `codegraph_explore` sweeps of all of `agent/src/` found no module that
   periodically collects/emits CPU/RAM/disk/latency. The real mechanism,
   confirmed via `backend-go/services/infra-fleet-service/internal/usecase/get_fleet_health.go`
   (`GetFleetHealth`, `NewPollFleetHealth`), is backend-go **polling** the
   dev server (consistent with `infra-fleet-service.md` section 8's "30s
   per dev server" - there is no 60-vs-30 mismatch, because there is no
   agent-side 60s emitter to compare against). Read A.1/A.2/A.7's "Health
   Reporter" language as historical/aspirational, not current behavior.

2. **A.2 step 8's "ReconnectManager: exponential backoff 5s -> 60s max" has
   the wrong numbers.** The real constant, `agent/src/relay/agent-connection-direct.ts`'s
   `RECONNECT_DELAYS_MS`, is `[1000, 2000, 5000, 15000, 30000]` (1s, capped
   at 30s) - not 5s-to-60s. See `03-connection-modes.md` section 6 and
   `04-handshake-session.md` section 9 for the full corrected reconnect
   behavior (this part of A.2 was directionally right - a reconnect loop
   really does exist - just with different numbers than stated).

Also relevant, not a correction but a gap this audit closed: `dev_servers.bootstrap_status`
and a `BootstrapFleetTarget` streaming RPC, implied by this doc's framing
of "Dev Server Onboard" (A.12) and by `specs/backend-go/tdd/services/infra-fleet-service.md`,
**do not exist in real backend-go code** - confirmed by grep across
`backend-go/services/infra-fleet-service/`. What does exist is
`infra.dev_servers.status` (`pending|healthy|degraded|unhealthy`) plus
`platform`/`arch`/`node_version`/`agent_version` columns (migration
`0007_dev_server_health_status.up.sql`), which map directly onto fields
`agent.handshake` already sends today - no agent change needed, only a
backend-go one (persist those handshake fields onto the real columns).
See `TASK-AG-STORAGE-003`'s completion notes for the full citation trail.
