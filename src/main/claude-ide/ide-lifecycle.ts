import { PortRegistry } from './port-registry'
import type { IpcBridge } from './ipc-bridge';
import { createIpcBridge } from './ipc-bridge'
import { handleToolCall } from './ide-tools'
import type { IdeLockfile } from './ide-protocol-types';
import { IDE_NAME } from './ide-protocol-types'
import type { IdeServer, StartIdeServerOptions } from './ide-server';

type Deps = {
  ideDir: string
  pid: number
  runningInWindows: boolean
  send: (channel: string, payload: unknown) => void
  startIdeServer: (opts: StartIdeServerOptions) => Promise<IdeServer>
  writeLockfile: (dir: string, port: number, data: IdeLockfile) => void
  removeLockfile: (dir: string, port: number) => void
}

export class IdeLifecycle {
  private deps: Deps
  private registry = new PortRegistry()
  private servers = new Map<string, IdeServer>()
  private bridges = new Map<string, IpcBridge>()

  constructor(deps: Deps) {
    this.deps = deps
  }

  async onWorktreeOpen(worktreeId: string, worktreePath: string): Promise<void> {
    if (this.servers.has(worktreeId)) {return}

    const { ideDir, pid, runningInWindows, send, startIdeServer, writeLockfile } = this.deps

    // Allocate with port=0 as a placeholder to get an authToken
    const { authToken } = this.registry.allocate(worktreeId, 0)

    const bridge = createIpcBridge(worktreeId, send)
    this.bridges.set(worktreeId, bridge)

    const server = await startIdeServer({ port: 0, authToken, bridge, handleToolCall })
    this.servers.set(worktreeId, server)

    // Update registry with the real port assigned by OS, preserving authToken
    this.registry.setPort(worktreeId, server.port)

    const lockfile: IdeLockfile = {
      pid,
      workspaceFolders: [worktreePath],
      ideName: IDE_NAME,
      transport: 'ws',
      runningInWindows,
      authToken,
    }
    writeLockfile(ideDir, server.port, lockfile)
  }

  envForWorktree(worktreeId: string): Record<string, string> {
    const entry = this.registry.entry(worktreeId)
    if (!entry) {return {}}
    return {
      CLAUDE_CODE_SSE_PORT: String(entry.port),
      ENABLE_IDE_INTEGRATION: 'true',
    }
  }

  resolveReply(m: { kind: 'verdict' | 'data'; worktreeId: string; requestId: string; value: unknown }): void {
    const bridge = this.bridges.get(m.worktreeId)
    if (!bridge) {return}
    if (m.kind === 'verdict') {
      bridge.resolvePending(m.requestId, m.value as 'keep' | 'reject')
    } else {
      bridge.resolveData(m.requestId, m.value)
    }
  }

  notifySelectionChanged(worktreeId: string, selection: { text: string; filePath: string } | null): void {
    const server = this.servers.get(worktreeId)
    server?.notify('selection_changed', selection)
  }

  async onWorktreeClose(worktreeId: string): Promise<void> {
    const { ideDir, removeLockfile } = this.deps
    const bridge = this.bridges.get(worktreeId)
    bridge?.rejectAllPending()

    const server = this.servers.get(worktreeId)
    if (server) {
      await server.close()
      removeLockfile(ideDir, server.port)
    }

    this.registry.release(worktreeId)
    this.servers.delete(worktreeId)
    this.bridges.delete(worktreeId)
  }
}
