import {
  asBrowserUseCdpTarget,
  asBrowserUseRecord,
  requireBrowserUseString,
  type CodexBrowserUseAdapter,
  type CodexBrowserUseRpcRequest,
  type CodexBrowserUseSession,
  type RpcNotificationEmitter
} from './codex-browser-use-protocol'
import type { CodexBrowserUseConnectionContext } from './codex-browser-use-backend'

export class CodexBrowserUseRpcRouter {
  private readonly browserSessions = new Map<string, CodexBrowserUseSession>()

  constructor(private readonly adapter: CodexBrowserUseAdapter) {}

  clear(): void {
    this.browserSessions.clear()
  }

  async dispatch(
    request: CodexBrowserUseRpcRequest,
    context: CodexBrowserUseConnectionContext,
    emit: RpcNotificationEmitter
  ): Promise<unknown> {
    if (request.method === 'ping') {
      return 'pong'
    }
    const session = this.requireSession(request.params)
    switch (request.method) {
      case 'getInfo':
        return {
          type: 'iab',
          name: 'Orca',
          metadata: {
            codexSessionId: session.sessionId,
            codexAppBuildFlavor: 'prod'
          },
          capabilities: { browser: [], tab: [] },
          apiSupportOverrides: {
            'Browser.nameSession': false,
            'BrowserUser.claimTab': false,
            'ContentAPI.export': false,
            'ContentAPI.exportGsuite': false,
            'Tabs.new': false
          }
        }
      case 'getTabs':
        return this.listTabs(session)
      case 'getUserTabs':
      case 'getUserHistory':
        return []
      case 'attach':
        return await this.attach(request, context, session, emit)
      case 'attachTarget': {
        const tab = this.requireTab(session, request.params?.tabId)
        const targetId = requireBrowserUseString(request.params?.targetId, 'targetId')
        if (!this.adapter.attachTarget) {
          throw new Error('Target attachment is unavailable')
        }
        await this.adapter.attachTarget(
          context.id,
          session.sessionId,
          session.worktreeId,
          tab.browserPageId,
          tab.tabId,
          targetId
        )
        return {}
      }
      case 'detach': {
        const tab = this.requireTab(session, request.params?.tabId)
        context.attachments.delete(tab.browserPageId)
        await this.adapter.detach(
          context.id,
          session.sessionId,
          session.worktreeId,
          tab.browserPageId
        )
        return {}
      }
      case 'detachTarget': {
        const tab = this.requireTab(session, request.params?.tabId)
        const targetId = requireBrowserUseString(request.params?.targetId, 'targetId')
        if (!this.adapter.detachTarget) {
          throw new Error('Target detachment is unavailable')
        }
        await this.adapter.detachTarget(
          context.id,
          session.sessionId,
          session.worktreeId,
          tab.browserPageId,
          targetId
        )
        return {}
      }
      case 'executeCdp': {
        const target = asBrowserUseCdpTarget(request.params?.target)
        const tab = this.requireTab(session, target.tabId)
        const method = requireBrowserUseString(request.params?.method, 'method')
        const commandParams = asBrowserUseRecord(request.params?.commandParams)
        return await this.adapter.executeCdp(
          context.id,
          session.sessionId,
          session.worktreeId,
          tab.browserPageId,
          target,
          method,
          commandParams
        )
      }
      case 'nameSession':
      case 'markTab':
      case 'finalizeTabs':
      case 'moveMouse':
      case 'turnEnded':
        return {}
      default:
        throw new Error(`No handler registered for method: ${request.method}`)
    }
  }

  private async attach(
    request: CodexBrowserUseRpcRequest,
    context: CodexBrowserUseConnectionContext,
    session: CodexBrowserUseSession,
    emit: RpcNotificationEmitter
  ): Promise<Record<string, never>> {
    const tab = this.requireTab(session, request.params?.tabId)
    await this.adapter.attach(
      context.id,
      session.sessionId,
      session.worktreeId,
      tab.browserPageId,
      tab.tabId,
      emit
    )
    const attachment = {
      sessionId: session.sessionId,
      worktreeId: session.worktreeId,
      browserPageId: tab.browserPageId
    }
    if (context.closed) {
      await this.adapter.detach(
        context.id,
        attachment.sessionId,
        attachment.worktreeId,
        attachment.browserPageId
      )
    } else {
      context.attachments.set(tab.browserPageId, attachment)
    }
    return {}
  }

  private requireSession(params: Record<string, unknown> | undefined): CodexBrowserUseSession {
    const sessionId = requireBrowserUseString(params?.session_id, 'session_id')
    const worktreeId = this.adapter.resolveWorktreeId(sessionId)
    if (!worktreeId) {
      throw new Error(`Codex session ${sessionId} is not associated with an Orca workspace`)
    }
    const existing = this.browserSessions.get(sessionId)
    if (existing?.worktreeId === worktreeId) {
      return existing
    }
    const session: CodexBrowserUseSession = {
      sessionId,
      worktreeId,
      pageIdByTabId: new Map(),
      tabIdByPageId: new Map(),
      nextTabId: 1
    }
    this.browserSessions.set(sessionId, session)
    return session
  }

  private listTabs(session: CodexBrowserUseSession): Record<string, unknown>[] {
    const tabs = this.adapter.listTabs(session.worktreeId)
    const livePageIds = new Set(tabs.map((tab) => tab.browserPageId))
    for (const [pageId, tabId] of session.tabIdByPageId) {
      if (!livePageIds.has(pageId)) {
        session.tabIdByPageId.delete(pageId)
        session.pageIdByTabId.delete(tabId)
      }
    }
    return tabs.map((tab) => {
      let id = session.tabIdByPageId.get(tab.browserPageId)
      if (id == null) {
        id = session.nextTabId++
        session.tabIdByPageId.set(tab.browserPageId, id)
        session.pageIdByTabId.set(id, tab.browserPageId)
      }
      return { id, url: tab.url, title: tab.title, active: tab.active }
    })
  }

  private requireTab(
    session: CodexBrowserUseSession,
    rawTabId: unknown
  ): { tabId: number; browserPageId: string } {
    const tabId = Number(rawTabId)
    if (!Number.isSafeInteger(tabId) || tabId < 1) {
      throw new Error('tabId must be a positive integer')
    }
    if (!session.pageIdByTabId.has(tabId)) {
      this.listTabs(session)
    }
    const browserPageId = session.pageIdByTabId.get(tabId)
    if (!browserPageId) {
      throw new Error(`Browser tab ${tabId} is not available`)
    }
    return { tabId, browserPageId }
  }
}
