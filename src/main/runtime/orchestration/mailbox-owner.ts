import type { AgentStatus } from '../../../shared/agent-detection'
import type { OrchestrationDb } from './db'

/** A live terminal mail pointers are typed into, keyed by its PTY rather than any window pane. */
export type OrchestrationMailboxTerminal = {
  ptyId: string
  /** The handle the terminal is known by; direct mail and Run coordinators name it. */
  handle: string
  /** Every pane Runs and Dispatches bind it by: two window panes can show one terminal. */
  paneKeys: readonly string[]
  lastAgentStatus: AgentStatus | null
  lastAgentStatusObservedLive: boolean
}

/** An agent at rest or mid-turn takes typed mail: agents queue or steer text sent during a turn. */
export function agentStatusTakesTypedInput(status: AgentStatus | null): boolean {
  return status === 'idle' || status === 'working'
}

export function isMailboxTerminalTakingInput(
  terminal: Pick<OrchestrationMailboxTerminal, 'lastAgentStatus' | 'lastAgentStatusObservedLive'>
): boolean {
  return (
    terminal.lastAgentStatusObservedLive && agentStatusTakesTypedInput(terminal.lastAgentStatus)
  )
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
  getTerminal: (ptyId: string) => OrchestrationMailboxTerminal | null
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  onRoutedMessageTypes: (mailboxHandle: string, types: readonly string[]) => void
  onForeignMailboxRouted: (mailboxHandle: string, messageType: string) => void
}

export class OrchestrationMailboxOwner {
  private readonly pendingDirectReconciliations = new Set<string>()
  private readonly pendingDetachedDirectReconciliations = new Set<string>()

  constructor(private readonly deps: OrchestrationMailboxOwnerDependencies) {}

  resolve(
    terminal: OrchestrationMailboxTerminal,
    requestedMailbox?: string,
    options: {
      requireRequestedMail?: boolean
      routeDirectMail?: boolean
    } = {}
  ): string | null {
    const db = this.deps.getDb()
    if (!db) {
      return null
    }
    const { handle: terminalHandle, paneKeys } = terminal
    const runs = this.runsBoundToTerminal(db, terminal)
    // A coordinator of several Runs owns each one's mailbox; unnamed mail goes to its current Run.
    const run = runs.find((bound) => requestedMailbox === `run:${bound.id}`) ?? runs[0]
    if (run) {
      return this.resolveRunMailbox(db, terminal, run.id, requestedMailbox, options)
    }

    const dispatch = firstDefined(paneKeys, (paneKey) =>
      db.getActiveDispatchForIdentity?.(terminalHandle, paneKey)
    )
    if (dispatch) {
      return this.resolveDispatchMailbox(
        db,
        terminal,
        dispatch.id,
        dispatch.run_id,
        requestedMailbox,
        options
      )
    }

    const attached = firstDefined(paneKeys, (paneKey) => {
      const attachment = db.findActiveRemoteAttachmentForPane?.(paneKey)
      return attachment ? { paneKey, remoteAttachment: attachment } : undefined
    })
    if (attached) {
      const { paneKey, remoteAttachment } = attached
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

  /** The terminal's mailbox, then every other Run it coordinates, so an input edge wakes each with mail. */
  resolveAll(terminal: OrchestrationMailboxTerminal): string[] {
    const mailboxHandle = this.resolve(terminal)
    if (!mailboxHandle) {
      return []
    }
    const db = this.deps.getDb()
    const runs = db ? this.runsBoundToTerminal(db, terminal) : []
    return [...new Set([mailboxHandle, ...runs.map((run) => `run:${run.id}`)])]
  }

  private runsBoundToTerminal(db: OrchestrationDb, terminal: OrchestrationMailboxTerminal) {
    return terminal.paneKeys.flatMap((paneKey) => db.runsBoundToPane?.(paneKey) ?? [])
  }

  routeForeignDirectMessages(terminal: OrchestrationMailboxTerminal): RoutedOrchestrationMailbox[] {
    const db = this.deps.getDb()
    if (!db) {
      return []
    }
    const ownerMailbox = this.resolve(terminal, undefined, { routeDirectMail: false })
    const ownerRunId = ownerMailbox?.startsWith('run:')
      ? ownerMailbox.slice('run:'.length)
      : ownerMailbox?.startsWith('dispatch:')
        ? db.getDispatchContextById?.(ownerMailbox.slice('dispatch:'.length))?.run_id
        : undefined
    if (!ownerRunId) {
      return []
    }
    const pages = terminal.paneKeys.map((paneKey) =>
      db.routeForeignDirectMessagesToOwnedMailboxes?.(terminal.handle, ownerRunId, paneKey)
    )
    if (pages.some((routed) => routed?.hasMore)) {
      this.scheduleDirectReconciliation(terminal)
    }
    return pages.flatMap((routed) => routed?.mailboxes ?? [])
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
    terminal: OrchestrationMailboxTerminal,
    runId: string,
    requestedMailbox: string | undefined,
    options: { requireRequestedMail?: boolean; routeDirectMail?: boolean }
  ): string | null {
    const terminalHandle = terminal.handle
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
        this.scheduleDirectReconciliation(terminal)
      }
    }
    return runMailbox
  }

  private resolveDispatchMailbox(
    db: OrchestrationDb,
    terminal: OrchestrationMailboxTerminal,
    dispatchId: string,
    runId: string,
    requestedMailbox: string | undefined,
    options: { requireRequestedMail?: boolean; routeDirectMail?: boolean }
  ): string | null {
    const terminalHandle = terminal.handle
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
        this.scheduleDirectReconciliation(terminal)
      }
    }
    return dispatchMailbox
  }

  private scheduleDirectReconciliation(terminal: OrchestrationMailboxTerminal): void {
    const { ptyId } = terminal
    if (this.pendingDirectReconciliations.has(ptyId)) {
      return
    }
    this.pendingDirectReconciliations.add(ptyId)
    setImmediate(() => {
      this.pendingDirectReconciliations.delete(ptyId)
      const current = this.deps.getTerminal(ptyId)
      if (!current) {
        return
      }
      for (const routed of this.routeForeignDirectMessages(current)) {
        for (const messageType of routed.types) {
          this.deps.onForeignMailboxRouted(routed.mailboxHandle, messageType)
        }
      }
      this.resolve(current)
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

function firstDefined<T, R>(items: readonly T[], read: (item: T) => R | undefined): R | undefined {
  for (const item of items) {
    const value = read(item)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}
