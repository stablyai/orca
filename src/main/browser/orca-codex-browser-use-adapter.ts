import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import {
  BrowserUseCdpConnection,
  type BrowserUseConnection,
  type BrowserUseConnectionFactory
} from './browser-use-cdp-connection'
import type {
  CodexBrowserUseAdapter,
  CodexBrowserUseCdpTarget,
  RpcNotificationEmitter
} from './codex-browser-use-protocol'

type OwnedConnection = {
  ownerId: string
  browserPageId: string
  worktreeId: string
  tabId: number
  emit: RpcNotificationEmitter
  connection: BrowserUseConnection | null
}

export class OrcaCodexBrowserUseAdapter implements CodexBrowserUseAdapter {
  private readonly connections = new Map<string, OwnedConnection>()
  private readonly connectionTails = new Map<string, Promise<void>>()
  private readonly unsubscribeProcessSwap: () => void

  constructor(
    private readonly bridge: AgentBrowserBridge,
    private readonly getAgentStatuses: () => AgentStatusIpcPayload[],
    private readonly isPaneLive: (paneKey: string) => boolean,
    private readonly createConnection: BrowserUseConnectionFactory = (
      proxy,
      tabId,
      emit,
      onClose
    ) => BrowserUseCdpConnection.create(proxy, tabId, emit, onClose)
  ) {
    this.unsubscribeProcessSwap = this.bridge.onCodexBrowserUseProcessSwap((browserPageId) =>
      this.invalidateBrowserPage(browserPageId)
    )
  }

  resolveWorktreeId(sessionId: string): string | null {
    const matches = this.getAgentStatuses().filter(
      (status) =>
        status.connectionId === null &&
        status.agentType === 'codex' &&
        status.providerSession?.key === 'session_id' &&
        status.providerSession.id === sessionId &&
        typeof status.worktreeId === 'string' &&
        this.isPaneLive(status.paneKey)
    )
    const worktreeIds = new Set(matches.map((status) => status.worktreeId!))
    return worktreeIds.size === 1 ? [...worktreeIds][0] : null
  }

  listTabs(worktreeId: string) {
    return this.bridge.tabList(worktreeId).tabs
  }

  async attach(
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string,
    tabId: number,
    emit: RpcNotificationEmitter
  ): Promise<void> {
    const key = this.connectionKey(sessionId, browserPageId)
    await this.withConnectionLock(key, async () => {
      const existing = this.connections.get(key)
      if (existing?.ownerId === connectionId && existing.connection) {
        return
      }
      if (existing) {
        this.connections.delete(key)
        await existing.connection?.close()
      }
      const owned: OwnedConnection = {
        ownerId: connectionId,
        browserPageId,
        worktreeId,
        tabId,
        emit,
        connection: null
      }
      this.connections.set(key, owned)
      try {
        await this.createOwnedConnection(key, browserPageId, owned)
      } catch (error) {
        if (this.connections.get(key) === owned) {
          this.connections.delete(key)
        }
        throw error
      }
    })
  }

  async detach(
    connectionId: string,
    sessionId: string,
    _worktreeId: string,
    browserPageId: string
  ): Promise<void> {
    const key = this.connectionKey(sessionId, browserPageId)
    await this.withConnectionLock(key, async () => {
      const owned = this.connections.get(key)
      if (owned?.ownerId !== connectionId) {
        return
      }
      this.connections.delete(key)
      await owned.connection?.close()
    })
  }

  async attachTarget(
    connectionId: string,
    sessionId: string,
    _worktreeId: string,
    browserPageId: string,
    _tabId: number,
    targetId: string
  ): Promise<void> {
    await this.withOwnedConnection(connectionId, sessionId, browserPageId, (connection) =>
      connection.attachTarget(targetId)
    )
  }

  async detachTarget(
    connectionId: string,
    sessionId: string,
    _worktreeId: string,
    browserPageId: string,
    targetId: string
  ): Promise<void> {
    await this.withOwnedConnection(connectionId, sessionId, browserPageId, (connection) =>
      connection.detachTarget(targetId)
    )
  }

  async executeCdp(
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string,
    target: CodexBrowserUseCdpTarget,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return await this.withOwnedConnection(connectionId, sessionId, browserPageId, (connection) => {
      if (method === 'Page.navigate' && typeof params.url === 'string') {
        return this.bridge.navigateCodexBrowserUseTab(worktreeId, browserPageId, params.url)
      }
      return connection.execute(target, method, params)
    })
  }

  async close(): Promise<void> {
    this.unsubscribeProcessSwap()
    const connections = [...this.connections.values()].flatMap(({ connection }) =>
      connection ? [connection] : []
    )
    this.connections.clear()
    this.connectionTails.clear()
    await Promise.allSettled(connections.map((connection) => connection.close()))
  }

  private async withOwnedConnection<T>(
    connectionId: string,
    sessionId: string,
    browserPageId: string,
    action: (connection: BrowserUseConnection) => Promise<T>
  ): Promise<T> {
    const key = this.connectionKey(sessionId, browserPageId)
    return await this.withConnectionLock(key, async () => {
      const owned = this.connections.get(key)
      if (!owned) {
        throw new Error('Browser tab is not attached')
      }
      if (owned.ownerId !== connectionId) {
        throw new Error('Browser connection is not owned by this native session')
      }
      const connection =
        owned.connection ?? (await this.createOwnedConnection(key, browserPageId, owned))
      try {
        return await action(connection)
      } catch (error) {
        const current = this.connections.get(key)
        if (current !== owned || current.ownerId !== connectionId || current.connection !== null) {
          throw error
        }
        const replacement = await this.createOwnedConnection(key, browserPageId, owned)
        return await action(replacement)
      }
    })
  }

  private invalidateBrowserPage(browserPageId: string): void {
    for (const owned of this.connections.values()) {
      if (owned.browserPageId !== browserPageId || !owned.connection) {
        continue
      }
      const stale = owned.connection
      owned.connection = null
      void stale.close().catch(() => undefined)
    }
  }

  private async createOwnedConnection(
    key: string,
    browserPageId: string,
    owned: OwnedConnection
  ): Promise<BrowserUseConnection> {
    const proxy = this.bridge.createCodexBrowserUseCdpProxy(owned.worktreeId, browserPageId)
    let created: BrowserUseConnection | null = null
    created = await this.createConnection(proxy, owned.tabId, owned.emit, () => {
      const current = this.connections.get(key)
      if (created && current === owned && current.connection === created) {
        current.connection = null
      }
    })
    if (this.connections.get(key) !== owned) {
      await created.close()
      throw new Error('Browser connection owner changed while attaching')
    }
    owned.connection = created
    return created
  }

  private async withConnectionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.connectionTails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(action)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.connectionTails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.connectionTails.get(key) === tail) {
        this.connectionTails.delete(key)
      }
    }
  }

  private connectionKey(sessionId: string, browserPageId: string): string {
    return `${sessionId}:${browserPageId}`
  }
}
