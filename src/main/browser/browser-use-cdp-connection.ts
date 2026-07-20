import { WebSocket } from 'ws'
import type { CdpWsProxy } from './cdp-ws-proxy'
import type { CodexBrowserUseCdpTarget, RpcNotificationEmitter } from './codex-browser-use-protocol'

type PendingCdpRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type BrowserUseConnection = {
  execute: (
    target: CodexBrowserUseCdpTarget,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>
  attachTarget: (targetId: string) => Promise<void>
  detachTarget: (targetId: string) => Promise<void>
  close: () => Promise<void>
}

export type BrowserUseConnectionFactory = (
  proxy: CdpWsProxy,
  tabId: number,
  emit: RpcNotificationEmitter,
  onClose: () => void
) => Promise<BrowserUseConnection>

export class BrowserUseCdpConnection implements BrowserUseConnection {
  private readonly pending = new Map<number, PendingCdpRequest>()
  private readonly debuggerSessionIdByTargetId = new Map<string, string>()
  private nextId = 1
  private closeNotified = false

  private constructor(
    private readonly proxy: CdpWsProxy,
    private readonly socket: WebSocket,
    private readonly tabId: number,
    private readonly emit: RpcNotificationEmitter,
    private readonly onClose: () => void
  ) {
    socket.on('message', (data) => this.onMessage(data.toString()))
    socket.once('close', () => {
      this.rejectPending(new Error('Browser CDP connection closed'))
      this.notifyClose()
    })
    socket.once('error', (error) => this.rejectPending(error))
  }

  static async create(
    proxy: CdpWsProxy,
    tabId: number,
    emit: RpcNotificationEmitter,
    onClose: () => void
  ): Promise<BrowserUseCdpConnection> {
    const endpoint = await proxy.start()
    const socket = new WebSocket(endpoint)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      return new BrowserUseCdpConnection(proxy, socket, tabId, emit, onClose)
    } catch (error) {
      socket.close()
      await proxy.stop()
      throw error
    }
  }

  async execute(
    target: CodexBrowserUseCdpTarget,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const sessionId = target.targetId
      ? this.debuggerSessionIdByTargetId.get(target.targetId)
      : target.sessionId
    return await this.request(method, params, sessionId)
  }

  async attachTarget(targetId: string): Promise<void> {
    const result = (await this.request('Target.attachToTarget', {
      targetId,
      flatten: true
    })) as { sessionId?: unknown }
    if (typeof result?.sessionId !== 'string') {
      throw new Error(`Browser target ${targetId} did not return a debugger session`)
    }
    this.debuggerSessionIdByTargetId.set(targetId, result.sessionId)
  }

  async detachTarget(targetId: string): Promise<void> {
    const sessionId = this.debuggerSessionIdByTargetId.get(targetId)
    if (!sessionId) {
      return
    }
    this.debuggerSessionIdByTargetId.delete(targetId)
    await this.request('Target.detachFromTarget', { sessionId })
  }

  async close(): Promise<void> {
    this.socket.close()
    this.rejectPending(new Error('Browser CDP connection closed'))
    this.notifyClose()
    await this.proxy.stop()
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Browser CDP connection is not open'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number
      result?: unknown
      error?: { message?: string }
      method?: string
      params?: unknown
      sessionId?: string
    }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'CDP request failed'))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (!message.method) {
      return
    }
    const targetId = message.sessionId
      ? [...this.debuggerSessionIdByTargetId].find(([, id]) => id === message.sessionId)?.[0]
      : undefined
    this.emit('onCDPEvent', {
      source: { tabId: this.tabId, ...(targetId ? { targetId } : {}) },
      method: message.method,
      params: message.params
    })
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      request.reject(error)
    }
    this.pending.clear()
  }

  private notifyClose(): void {
    if (this.closeNotified) {
      return
    }
    this.closeNotified = true
    this.onClose()
  }
}
