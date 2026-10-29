import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import type { ClientWorkspaceView } from '../../../shared/rpc-contract/client-workspace-view-params'

type ClientView = { workspaceKeys: Set<string>; tabIds: Set<string>; presentUntil: number }

/** Suppress host unread for reported desktop views and open phone sessions; workspace identity normalizes checkout path spellings. */
export class WorkspaceViewers {
  private readonly clients = new Map<string, ClientView>()
  private readonly phoneSessions = new Map<string, number>()
  private readonly selfRaisingClients = new Set<string>()

  constructor(private readonly now: () => number) {}

  /** Replaces the client's view; true the first time, so the caller ties it to the connection. */
  reportClientView(clientKey: string, view: ClientWorkspaceView): boolean {
    const known = this.clients.has(clientKey)
    this.clients.set(clientKey, {
      workspaceKeys: new Set(view.workspaceIds.map(worktreeIdentityKey)),
      tabIds: new Set(view.tabIds),
      presentUntil:
        view.presentForMs === null ? Number.POSITIVE_INFINITY : this.now() + view.presentForMs
    })
    return !known
  }

  /** Older desktops raise unread themselves; defer host raising until their connection drops via dropClient. */
  noteSelfRaisingClient(clientKey: string): void {
    this.selfRaisingClients.add(clientKey)
  }

  dropClient(clientKey: string): void {
    this.clients.delete(clientKey)
    this.selfRaisingClients.delete(clientKey)
  }

  /** A phone's open session on the workspace, until the returned release. */
  openPhoneSession(worktreeId: string): () => void {
    const key = worktreeIdentityKey(worktreeId)
    this.phoneSessions.set(key, (this.phoneSessions.get(key) ?? 0) + 1)
    let open = true
    return () => {
      if (!open) {
        return
      }
      open = false
      const remaining = (this.phoneSessions.get(key) ?? 1) - 1
      if (remaining > 0) {
        this.phoneSessions.set(key, remaining)
      } else {
        this.phoneSessions.delete(key)
      }
    }
  }

  /** As the window's own rule: a pane is seen when its tab is on screen, else the workspace. */
  isViewing(worktreeId: string, paneKey: string | null): boolean {
    const key = worktreeIdentityKey(worktreeId)
    if (this.selfRaisingClients.size > 0 || this.phoneSessions.has(key)) {
      return true
    }
    const tabId = paneKey === null ? null : (parsePaneKey(paneKey)?.tabId ?? null)
    const now = this.now()
    for (const view of this.clients.values()) {
      if (
        now < view.presentUntil &&
        (tabId === null ? view.workspaceKeys.has(key) : view.tabIds.has(tabId))
      ) {
        return true
      }
    }
    return false
  }
}
