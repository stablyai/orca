import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import type { ClientWorkspaceView } from '../../../shared/rpc-contract/client-workspace-view-params'

type ClientView = { workspaceKeys: Set<string>; tabIds: Set<string>; presentUntil: number }
type PhoneSession = { clientKey: string | null; worktreeId: string }

/**
 * Who is looking at this host's workspaces: client windows by what they report on screen, and
 * phones by the session they hold open while present. The host's unread flag skips what someone is
 * looking at.
 * Workspaces are keyed by identity, so path spellings of one checkout match.
 *
 * A phone's held session counts by its connection's latest report. None (an older page): always.
 * Presence only, naming no workspace (an earlier page): while present. Naming its focused session
 * route: only that one, while present, so a route left behind another screen is not on screen.
 */
export class WorkspaceViewers {
  private readonly clients = new Map<string, ClientView>()
  private readonly phoneSessions = new Map<string, Set<PhoneSession>>()
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

  /** An older desktop raises the flag itself and reports no view, so while it is connected the
   *  host leaves raising to it. The caller drops it with {@link dropClient} when it closes. */
  noteSelfRaisingClient(clientKey: string): void {
    this.selfRaisingClients.add(clientKey)
  }

  dropClient(clientKey: string): void {
    this.clients.delete(clientKey)
    this.selfRaisingClients.delete(clientKey)
  }

  /** A phone's open session on the workspace, until the returned release; counted while its
   *  connection is present (an older phone never reports away, so until its socket closes). */
  openPhoneSession(clientKey: string | null, worktreeId: string): () => void {
    const key = worktreeIdentityKey(worktreeId)
    const session: PhoneSession = { clientKey, worktreeId }
    const sessions = this.phoneSessions.get(key) ?? new Set<PhoneSession>()
    sessions.add(session)
    this.phoneSessions.set(key, sessions)
    return () => {
      if (sessions.delete(session) && sessions.size === 0) {
        this.phoneSessions.delete(key)
      }
    }
  }

  /** The workspaces this client's held phone sessions show now. */
  shownPhoneSessions(clientKey: string): string[] {
    const now = this.now()
    const worktreeIds: string[] = []
    for (const [key, sessions] of this.phoneSessions) {
      const held = [...sessions].find((session) => session.clientKey === clientKey)
      if (held && this.showsPhoneSession(clientKey, key, now)) {
        worktreeIds.push(held.worktreeId)
      }
    }
    return worktreeIds
  }

  /** Whether a phone session this client opens on the workspace is on screen. */
  showsWorkspace(clientKey: string, worktreeId: string): boolean {
    return this.showsPhoneSession(clientKey, worktreeIdentityKey(worktreeId), this.now())
  }

  /** As the window's own rule: a pane is seen when its tab is on screen, else the workspace. */
  isViewing(worktreeId: string, paneKey: string | null): boolean {
    const key = worktreeIdentityKey(worktreeId)
    const now = this.now()
    if (this.selfRaisingClients.size > 0 || this.holdsPresentPhoneSession(key, now)) {
      return true
    }
    const tabId = paneKey === null ? null : (parsePaneKey(paneKey)?.tabId ?? null)
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

  private holdsPresentPhoneSession(workspaceKey: string, now: number): boolean {
    for (const session of this.phoneSessions.get(workspaceKey) ?? []) {
      if (this.showsPhoneSession(session.clientKey, workspaceKey, now)) {
        return true
      }
    }
    return false
  }

  private showsPhoneSession(clientKey: string | null, workspaceKey: string, now: number): boolean {
    // A connection with no id (in-process) cannot report.
    const view = clientKey === null ? undefined : this.clients.get(clientKey)
    return (
      view === undefined ||
      (now < view.presentUntil &&
        (view.workspaceKeys.size === 0 || view.workspaceKeys.has(workspaceKey)))
    )
  }
}
