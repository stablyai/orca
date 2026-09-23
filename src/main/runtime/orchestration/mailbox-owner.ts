import type { AgentStatus } from '../../../shared/agent-detection'
import type { OrchestrationDb } from './db'
import type { OrchestrationCallerIdentity } from './orchestration-caller-identity'
import { sessionOrchestrationIdentity } from './structured-session-mail-address'

export type OrchestrationMailboxLeaf = {
  tabId: string
  leafId: string
  ptyId: string | null
  writable: boolean
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
  lastOscTitle: string | null
  paneTitle?: string | null
}

export type RoutedOrchestrationMailbox = {
  mailboxHandle: string
  types: string[]
}

export type DetachedMailboxRoutingPage = {
  mailboxes: RoutedOrchestrationMailbox[]
  hasMore: boolean
}

type OrchestrationMailboxOwnerDependencies = {
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getTerminalHandleForLeafKey: (leafKey: string) => string | undefined
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  onRoutedMessageTypes: (mailboxHandle: string, types: readonly string[]) => void
  onForeignMailboxRouted: (mailboxHandle: string, messageType: string) => void
  /** The structured session a PTY is the terminal view of, if any. */
  getBoundSessionIdForPty?: (ptyId: string) => string | null
}

export class OrchestrationMailboxOwner {
  private readonly pendingDirectReconciliations = new Set<string>()
  private readonly pendingDetachedDirectReconciliations = new Set<string>()

  constructor(private readonly deps: OrchestrationMailboxOwnerDependencies) {}

  resolve(
    leaf: OrchestrationMailboxLeaf,
    requestedMailbox?: string,
    options: {
      requireRequestedMail?: boolean
      routeDirectMail?: boolean
      terminalHandle?: string
    } = {}
  ): string | null {
    const db = this.deps.getDb()
    if (!db) {
      return null
    }
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    const terminalHandle = options.terminalHandle ?? this.deps.getTerminalHandleForLeafKey(leafKey)
    if (!terminalHandle) {
      return null
    }
    const paneKey = `${leaf.tabId}:${leaf.leafId}`
    const session = this.sessionMailOwner(db, leaf)
    const sessionRun = session ? db.getCurrentRunForCoordinator?.(session) : null
    const run = sessionRun ?? db.getCurrentRunForPane?.(paneKey)
    if (run) {
      const address = sessionRun && session ? session.address : terminalHandle
      return this.resolveRunMailbox(db, leaf, address, run.id, requestedMailbox, options)
    }

    const sessionDispatch = session
      ? db.getActiveDispatchForIdentity?.(session.address, session.paneKey ?? undefined)
      : null
    const dispatch = sessionDispatch ?? db.getActiveDispatchForIdentity?.(terminalHandle, paneKey)
    if (dispatch) {
      return this.resolveDispatchMailbox(
        db,
        leaf,
        sessionDispatch && session ? session.address : terminalHandle,
        dispatch.id,
        dispatch.run_id,
        requestedMailbox,
        options
      )
    }

    const remoteAttachment = db.findActiveRemoteAttachmentForPane?.(paneKey)
    if (remoteAttachment) {
      const isCurrent = db.isRemoteAttachmentProcessCurrent?.({
        dispatchId: remoteAttachment.dispatch_id,
        paneKey,
        processIncarnation: this.deps.getTerminalProcessIncarnation(terminalHandle)
      })
      if (!isCurrent || (options.requireRequestedMail && requestedMailbox === terminalHandle)) {
        return null
      }
      const dispatchMailbox = `dispatch:${remoteAttachment.dispatch_id}`
      return !requestedMailbox || requestedMailbox === dispatchMailbox ? dispatchMailbox : null
    }

    return !requestedMailbox || requestedMailbox === terminalHandle ? terminalHandle : null
  }

  /**
   * A terminal view speaks for its session (the CLI there acts as the session), so its Run and
   * Dispatch are the session's. A PTY-born worker adopted into a session still owns its mail by
   * terminal, which is why callers fall back to the pane when the session owns nothing.
   */
  private sessionMailOwner(
    db: OrchestrationDb,
    leaf: OrchestrationMailboxLeaf
  ): OrchestrationCallerIdentity | null {
    const sessionId = leaf.ptyId ? this.deps.getBoundSessionIdForPty?.(leaf.ptyId) : null
    return sessionId ? sessionOrchestrationIdentity(sessionId, db) : null
  }

  routeForeignDirectMessages(leaf: OrchestrationMailboxLeaf): RoutedOrchestrationMailbox[] {
    const db = this.deps.getDb()
    if (!db) {
      return []
    }
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    const terminalHandle = this.deps.getTerminalHandleForLeafKey(leafKey)
    if (!terminalHandle) {
      return []
    }
    const paneKey = `${leaf.tabId}:${leaf.leafId}`
    const ownerMailbox = this.resolve(leaf, undefined, { routeDirectMail: false })
    const ownerRunId = ownerMailbox?.startsWith('run:')
      ? ownerMailbox.slice('run:'.length)
      : ownerMailbox?.startsWith('dispatch:')
        ? db.getDispatchContextById?.(ownerMailbox.slice('dispatch:'.length))?.run_id
        : undefined
    if (!ownerRunId) {
      return []
    }
    const session = this.sessionMailOwner(db, leaf)
    const sessionOwnsRun =
      session !== null && db.getCurrentRunForCoordinator?.(session)?.id === ownerRunId
    const routed = db.routeForeignDirectMessagesToOwnedMailboxes?.(
      sessionOwnsRun ? session.address : terminalHandle,
      ownerRunId,
      sessionOwnsRun ? (session.paneKey ?? undefined) : paneKey
    )
    if (routed?.hasMore) {
      this.scheduleDirectReconciliation(leaf)
    }
    return routed?.mailboxes ?? []
  }

  routeDetachedDirectMessages(directHandle: string, paneKey?: string): DetachedMailboxRoutingPage {
    const routed = this.deps
      .getDb()
      ?.routeForeignDirectMessagesToOwnedMailboxes?.(directHandle, undefined, paneKey)
    if (routed?.hasMore) {
      this.scheduleDetachedDirectReconciliation(directHandle, paneKey)
    }
    return { mailboxes: routed?.mailboxes ?? [], hasMore: routed?.hasMore ?? false }
  }

  private resolveRunMailbox(
    db: OrchestrationDb,
    leaf: OrchestrationMailboxLeaf,
    terminalHandle: string,
    runId: string,
    requestedMailbox: string | undefined,
    options: { requireRequestedMail?: boolean; routeDirectMail?: boolean }
  ): string | null {
    const runMailbox = `run:${runId}`
    if (
      requestedMailbox &&
      requestedMailbox !== terminalHandle &&
      requestedMailbox !== runMailbox
    ) {
      return null
    }
    const hasDirectMail =
      options.routeDirectMail === false
        ? false
        : (db.hasUndeliveredDirectMessageForRun?.(runId, terminalHandle) ?? false)
    if (options.requireRequestedMail && requestedMailbox === terminalHandle && !hasDirectMail) {
      return null
    }
    if (hasDirectMail) {
      const routed = db.routeUnreadDirectMessagesToRunMailbox?.(runId, terminalHandle)
      this.deps.onRoutedMessageTypes(runMailbox, routed?.types ?? [])
      if (routed?.hasMore) {
        this.scheduleDirectReconciliation(leaf)
      }
    }
    return runMailbox
  }

  private resolveDispatchMailbox(
    db: OrchestrationDb,
    leaf: OrchestrationMailboxLeaf,
    terminalHandle: string,
    dispatchId: string,
    runId: string,
    requestedMailbox: string | undefined,
    options: { requireRequestedMail?: boolean; routeDirectMail?: boolean }
  ): string | null {
    const dispatchMailbox = `dispatch:${dispatchId}`
    if (
      requestedMailbox &&
      requestedMailbox !== terminalHandle &&
      requestedMailbox !== dispatchMailbox
    ) {
      return null
    }
    const hasDirectMail =
      options.routeDirectMail === false
        ? false
        : (db.hasUndeliveredDirectMessageForRun?.(runId, terminalHandle) ?? false)
    if (options.requireRequestedMail && requestedMailbox === terminalHandle && !hasDirectMail) {
      return null
    }
    if (hasDirectMail) {
      const routed = db.routeUnreadDirectMessagesToDispatchMailbox?.(
        dispatchId,
        runId,
        terminalHandle
      )
      this.deps.onRoutedMessageTypes(dispatchMailbox, routed?.types ?? [])
      if (routed?.hasMore) {
        this.scheduleDirectReconciliation(leaf)
      }
    }
    return dispatchMailbox
  }

  private scheduleDirectReconciliation(leaf: OrchestrationMailboxLeaf): void {
    const leafKey = this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    if (this.pendingDirectReconciliations.has(leafKey)) {
      return
    }
    this.pendingDirectReconciliations.add(leafKey)
    setImmediate(() => {
      this.pendingDirectReconciliations.delete(leafKey)
      const currentLeaf = this.deps.getLeaf(leafKey)
      if (!currentLeaf || currentLeaf.ptyId !== leaf.ptyId) {
        return
      }
      for (const routed of this.routeForeignDirectMessages(currentLeaf)) {
        for (const messageType of routed.types) {
          this.deps.onForeignMailboxRouted(routed.mailboxHandle, messageType)
        }
      }
      this.resolve(currentLeaf)
    })
  }

  private scheduleDetachedDirectReconciliation(directHandle: string, paneKey?: string): void {
    if (this.pendingDetachedDirectReconciliations.has(directHandle)) {
      return
    }
    this.pendingDetachedDirectReconciliations.add(directHandle)
    setImmediate(() => {
      this.pendingDetachedDirectReconciliations.delete(directHandle)
      const routed = this.routeDetachedDirectMessages(directHandle, paneKey)
      for (const mailbox of routed.mailboxes) {
        for (const messageType of mailbox.types) {
          this.deps.onForeignMailboxRouted(mailbox.mailboxHandle, messageType)
        }
      }
      if (!routed.hasMore) {
        for (const messageType of this.deps.getDb()?.getUnreadDirectMessageTypes(directHandle) ??
          []) {
          this.deps.onForeignMailboxRouted(directHandle, messageType)
        }
      }
    })
  }
}
