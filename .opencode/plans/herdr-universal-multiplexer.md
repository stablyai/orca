# Plan: herdr as Universal Multiplexer & Agent Backend

## Goal
Make herdr the single multiplexer for ALL terminals (local, SSH, remote) and the backend where ALL agents (local and remote) run. Single local herdr daemon manages everything.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Orca Renderer (xterm.js)                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  herdr PTY Provider (Primary)                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    herdr Local Daemon                       │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │ │
│  │  │ Local PTYs   │  │ SSH PTYs     │  │ Remote Runtime   │  │ │
│  │  │ (node-pty)   │  │ (SSH conn)   │  │ (relay stream)   │  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │ │
│  │  ┌────────────────────────────────────────────────────────┐ │ │
│  │  │              herdr Internal Multiplexer                 │ │ │
│  │  │  Panes │ Splits │ Tabs │ Sessions │ Scrollback │ Agent │ │ │
│  │  └────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Key Changes

### 1. herdr Binary & Daemon (`src/main/providers/multiplexer/herdr/`)
- **herdr runs as local daemon** on user's machine (not remote)
- **Single herdr instance** manages all PTYs
- **herdr CLI transport** for local communication (Unix socket / named pipe)
- **herdr manages its own child processes** (replaces node-pty direct usage)

### 2. herdr PTY Provider Becomes Primary (`src/main/providers/multiplexer/herdr/herdr-pty-provider.ts`)
- **No fallback wrapper** - herdr provider IS the provider
- Implements `IPtyProvider` directly
- All `spawn()`, `attach()`, `write()`, `resize()`, `shutdown()` route to herdr daemon
- herdr handles: pane creation, splits, tabs, sessions, scrollback, buffer snapshots

### 3. Local PTY Management via herdr
- **herdr spawns local PTYs** using node-pty internally (or native child_process)
- **Local shells, agents** run inside herdr panes
- **Worktree-scoped history, env, cwd** managed by herdr
- **WSL support** via herdr

### 4. SSH PTY Management via herdr
- **herdr opens SSH connections** (replaces SSH provider)
- **SSH multiplexing** - single SSH connection, multiple panes
- **SSH agent forwarding, keys** managed by herdr
- **herdr handles SSH reconnection** transparently

### 5. Remote Runtime Integration
- **Remote runtime connects to LOCAL herdr** (not remote herdr)
- **Relay streams** into herdr panes
- **Remote runtime becomes a "backend" for herdr panes**

### 6. Agent Execution Inside herdr Panes
- **All agents** (codex, claude, omp, pi, grok, etc.) spawn inside herdr panes
- **herdr manages agent lifecycle**: spawn, detect, track, resume
- **Agent detection** via herdr's built-in agent status protocol
- **Draft prompt injection** via herdr pane send_keys

### 7. Remove/Replace Legacy Providers
- **DELETE**: `LocalPtyProvider` (node-pty direct usage)
- **DELETE**: `SshPtyProvider` / SSH relay session
- **DELETE**: `RemoteRuntimePtyProvider`
- **REPLACE**: Provider routing → always herdr provider
- **REPLACE**: `getProvider()` / `getProviderForPty()` → single herdr provider

### 8. Provider Routing (`src/main/ipc/pty.ts`)
- `getProvider()` → returns herdr provider
- `getProviderForPty()` → returns herdr provider
- All PTY IDs are herdr PTY IDs (encoded herdr identity)

### 9. Configuration & Settings
- `herdrBinarySource` setting (system/custom)
- herdr daemon auto-start/stop with Orca
- herdr session persistence across restarts
- Per-worktree herdr session names

### 10. IPC & Renderer Changes
- Renderer `pty-connection.ts` → talks to herdr provider
- `dataCallback`, `onResize`, `onExit` → herdr events
- Focus/attention tracking → herdr pane focus
- Agent status → herdr agent status protocol

## Implementation Steps (Big Bang)

### Phase 1: herdr Daemon & Local PTYs
1. Create herdr daemon entry point (spawns as child of Orca main)
2. Implement herdr CLI transport (Unix socket / named pipe)
3. herdr spawns local PTYs via node-pty internally
4. herdr manages pane lifecycle: create, split, resize, close
5. herdr handles local shell spawn (bash/zsh/fish/pwsh/WSL)

### Phase 2: herdr as Primary Provider
1. Refactor `HerdrPtyProvider` to implement `IPtyProvider` directly (no fallback)
2. Implement all `IPtyProvider` methods via herdr daemon RPC
3. Update `getProvider()` / `getProviderForPty()` to return herdr provider
4. PTY ID encoding = herdr identity (project, workspace, tab, pane)

### Phase 3: SSH via herdr
1. herdr opens SSH connections (ssh2 or ssh.exe)
2. herdr multiplexes SSH channels as panes
3. SSH agent forwarding, key management
4. SSH reconnection handled by herdr daemon

### Phase 4: Remote Runtime → Local herdr
1. Remote runtime connects to local herdr via relay
2. Relay streams become herdr pane data sources
3. Remote runtime PTYs = herdr panes backed by relay streams

### Phase 5: Agent Execution in herdr
1. Agent spawn = herdr pane create + command send
2. Agent detection via herdr status protocol (OSC 9999)
3. Draft prompt injection via herdr pane send_keys
4. Agent resume = herdr pane reattach

### Phase 6: Cleanup & Migration
1. Remove `LocalPtyProvider`, `SshPtyProvider`, `RemoteRuntimePtyProvider`
2. Remove provider routing logic (`getProvider`, `sshProviders` map)
3. Update all callers to use herdr provider
4. Update renderer `pty-connection.ts` for herdr events
5. Update tests

## Technical Details

### herdr Daemon Lifecycle
```typescript
// Orca main process starts herdr daemon on startup
const herdrDaemon = spawn(herdrExecutable, ['daemon'], {
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
})
```

### herdr RPC Protocol (JSON over Unix socket/named pipe)
```typescript
interface HerdrRequest {
  id: string
  method: 'pane.create' | 'pane.split' | 'pane.resize' | 'pane.close' |
          'pane.send_keys' | 'session.list' | 'agent.status' | ...
  params: unknown
}

interface HerdrResponse {
  id: string
  result?: unknown
  error?: { code: string; message: string }
}
```

### PTY ID Format (herdr identity)
```
herdr:v2:{workspaceId}:{projectId}:{tabId}:{leafId}:{paneId}
```
Encoded as base64url for transport.

### herdr Provider Implementation
```typescript
class HerdrPtyProvider implements IPtyProvider {
  private client: HerdrDaemonClient

  async spawn(opts): Promise<PtySpawnResult> {
    const resp = await this.client.request('pane.create', {
      workspace: opts.worktreeId,
      project: opts.worktreeId, // or derived
      tab: opts.tabId,
      leaf: opts.paneKey,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      command: opts.command,
      launchAgent: opts.launchAgent,
    })
    return { id: resp.paneId, ... }
  }

  write(id: string, data: string): void {
    this.client.notify('pane.send_keys', { pane_id: id, keys: [data] })
  }

  // ... all IPtyProvider methods
}
```

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| herdr daemon crash → all terminals die | herdr daemon supervised by Orca; auto-restart + pane reattach |
| Performance: herdr overhead | herdr is Go/Rust; minimal overhead vs node-pty |
| SSH connection management | herdr manages SSH connections internally; proven pattern |
| Remote runtime integration | Relay streams → herdr panes; existing relay protocol compatible |
| Agent detection | herdr has built-in agent status protocol (OSC 9999) |
| Migration complexity | Big bang with feature flag; can rollback to legacy providers |
| Windows support | herdr.exe with named pipes; node-pty fallback for ConPTY |

## Testing Strategy
1. Unit tests: herdr daemon client, PTY ID encoding, RPC protocol
2. Integration tests: local spawn, split, resize, SSH connect, agent spawn
3. E2E tests: full agent workflows (codex, claude), SSH worktrees, remote runtime
4. Performance: latency, memory, CPU vs current providers
5. Regression: all existing terminal features work identically

## Files to Modify/Create

### New Files
- `src/main/providers/multiplexer/herdr/herdr-daemon.ts` - daemon entry point
- `src/main/providers/multiplexer/herdr/herdr-daemon-client.ts` - RPC client
- `src/main/providers/multiplexer/herdr/herdr-transport.ts` - Unix socket/named pipe transport
- `src/main/providers/multiplexer/herdr/herdr-pty-provider.ts` - refactored as primary provider

### Modified Files
- `src/main/ipc/pty.ts` - provider routing → herdr only
- `src/main/daemon/daemon-init.ts` - start herdr daemon
- `src/main/providers/multiplexer/herdr/herdr-provider-factory.ts` - simplified
- `src/renderer/src/components/terminal-pane/pty-connection.ts` - herdr events
- `src/shared/terminal-backend.ts` - herdr as universal backend type

### Deleted Files
- `src/main/providers/local-pty-provider.ts`
- `src/main/providers/local-pty-utils.ts`
- `src/main/providers/local-pty-shell-ready.ts`
- `src/main/ssh/ssh-pty-provider.ts`
- `src/main/ssh/ssh-relay-session.ts`
- `src/main/runtime/remote-runtime-pty-transport.ts`
- `src/main/runtime/web-runtime-session.ts`

## Rollout
1. Feature flag: `settings.herdrUniversalMultiplexer`
2. Canary: internal team
3. Gradual rollout with telemetry
4. Full removal of legacy providers after validation

---

**Estimated Effort**: 4-6 weeks for core implementation, 2 weeks testing/rollout
**Team**: 2-3 engineers (1 herdr daemon, 1 provider integration, 1 renderer/SSH)
