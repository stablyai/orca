import type { MessagePriority, MessageRow, MessageType } from './orca-runtime-test-mocks.spec'

// Why: these tests only need message-queue semantics; real SQLite would make them fail on unrelated native runtime ABI drift.
export class InMemoryOrchestrationMessages {
  private sequence = 0

  private activeCoordinatorRun: { coordinator_handle: string } | null = null

  private messages: MessageRow[] = []

  private runs = new Map<
    string,
    { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
  >()

  insertMessage(msg: {
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
  }): MessageRow {
    this.sequence += 1
    const row: MessageRow = {
      id: `msg_${this.sequence}`,
      run_id: 'run_test',
      from_handle: msg.from,
      to_handle: msg.to,
      subject: msg.subject,
      body: msg.body ?? '',
      type: msg.type ?? 'status',
      priority: msg.priority ?? 'normal',
      thread_id: msg.threadId ?? null,
      payload: msg.payload ?? null,
      read: 0,
      sequence: this.sequence,
      created_at: '1970-01-01 00:00:00',
      delivered_at: null,
      sender_pane_key: null
    }
    this.messages.push(row)
    return row
  }

  getUnreadMessages(toHandle: string, types?: MessageType[]): MessageRow[] {
    return this.messages
      .filter(
        (message) =>
          message.to_handle === toHandle &&
          message.read === 0 &&
          (!types || types.length === 0 || types.includes(message.type))
      )
      .sort((a, b) => a.sequence - b.sequence)
  }

  getUndeliveredUnreadMessages(
    toHandle: string,
    types?: MessageType[],
    options?: { excludeTypes?: readonly string[]; limit?: number }
  ): MessageRow[] {
    const excluded = new Set(options?.excludeTypes ?? [])
    const rows = this.getUnreadMessages(toHandle, types).filter(
      (message) =>
        !message.delivered_at &&
        (message.pointer_enter_pending ?? 0) === 0 &&
        !excluded.has(message.type)
    )
    return options?.limit === undefined ? rows : rows.slice(0, Math.max(1, options.limit))
  }

  getUndeliveredUnreadMailboxHandles(): string[] {
    return [
      ...new Set(
        this.messages
          .filter(
            (message) =>
              message.read === 0 &&
              !message.delivered_at &&
              (message.pointer_enter_pending ?? 0) === 0
          )
          .map((message) => message.to_handle)
      )
    ]
  }

  getPendingMailboxPointerMessages(toHandle: string): MessageRow[] {
    return this.messages.filter(
      (message) =>
        message.to_handle === toHandle &&
        message.read === 0 &&
        (message.pointer_enter_pending ?? 0) > 0
    )
  }

  getPendingMailboxPointerHandles(): string[] {
    return [
      ...new Set(
        this.messages
          .filter((message) => message.read === 0 && (message.pointer_enter_pending ?? 0) > 0)
          .map((message) => message.to_handle)
      )
    ]
  }

  stageMailboxPointerEnter(
    ids: string[],
    target: { ptyId: string; processIncarnation: string }
  ): boolean {
    const stagedIds = new Set(ids)
    const claimed = this.messages.filter(
      (message) =>
        stagedIds.has(message.id) &&
        message.read === 0 &&
        (message.pointer_enter_pending ?? 0) === 0
    )
    // Production claims all-or-nothing, so a stolen reservation must not half-succeed here.
    if (claimed.length !== ids.length) {
      return false
    }
    for (const message of claimed) {
      message.pointer_enter_pending = 1
      message.pointer_pty_id = target.ptyId
      message.pointer_process_incarnation = target.processIncarnation
    }
    return true
  }

  markMailboxPointerWriteAttempted(
    ids: string[],
    target: { ptyId: string; processIncarnation: string }
  ): boolean {
    return this.advanceMailboxPointerPhase(ids, target, 1, 2)
  }

  markMailboxPointerEnterAttempted(
    ids: string[],
    target: { ptyId: string; processIncarnation: string }
  ): boolean {
    return this.advanceMailboxPointerPhase(ids, target, 2, 3)
  }

  settleMailboxPointerEnter(
    ids: string[],
    target: { ptyId: string; processIncarnation: string },
    expectedPhases: readonly number[]
  ): void {
    const settled = this.matchMailboxPointerEnter(ids, target, expectedPhases)
    for (const message of this.messages) {
      if (settled.has(message.id)) {
        message.delivered_at ??= '1970-01-01 00:00:00'
      }
    }
    this.clearMailboxPointerEnter(settled)
  }

  releaseMailboxPointerEnter(
    ids: string[],
    target: { ptyId: string; processIncarnation: string },
    expectedPhases: readonly number[]
  ): void {
    const released = this.matchMailboxPointerEnter(ids, target, expectedPhases)
    for (const message of this.messages) {
      if (released.has(message.id) && message.read === 0) {
        message.delivered_at = null
      }
    }
    this.clearMailboxPointerEnter(released)
  }

  releasePendingMailboxPointerForPty(ptyId: string): void {
    const reservedIds = new Set(
      this.messages
        .filter(
          (message) => message.pointer_enter_pending === 1 && message.pointer_pty_id === ptyId
        )
        .map((message) => message.id)
    )
    const pendingIds = new Set(
      this.messages
        .filter(
          (message) => (message.pointer_enter_pending ?? 0) > 0 && message.pointer_pty_id === ptyId
        )
        .map((message) => message.id)
    )
    for (const message of this.messages) {
      if (reservedIds.has(message.id) && message.read === 0) {
        message.delivered_at = null
      } else if (pendingIds.has(message.id) && message.read === 0) {
        message.delivered_at ??= '1970-01-01 00:00:00'
      }
    }
    this.clearMailboxPointerEnter(pendingIds)
  }

  setActiveCoordinatorRun(run: { coordinator_handle: string } | null): void {
    this.activeCoordinatorRun = run
  }

  getActiveCoordinatorRun(): { coordinator_handle: string } | null {
    return this.activeCoordinatorRun
  }

  setRun(run: {
    id: string
    coordinator_handle: string | null
    coordinator_pane_key?: string | null
  }): void {
    this.runs.set(run.id, { coordinator_pane_key: null, ...run })
  }

  getRun(
    id: string
  ):
    | { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
    | undefined {
    return this.runs.get(id)
  }

  getCurrentRunForPane(
    paneKey: string
  ):
    | { id: string; coordinator_handle: string | null; coordinator_pane_key: string | null }
    | undefined {
    return [...this.runs.values()].find((run) => run.coordinator_pane_key === paneKey)
  }

  listWorkerTerminalReleaseBacklog(): never[] {
    return []
  }

  hasUndeliveredDirectMessageForRun(runId: string, directHandle: string): boolean {
    return this.messages.some(
      (message) =>
        message.run_id === runId &&
        message.to_handle === directHandle &&
        message.read === 0 &&
        !message.delivered_at
    )
  }

  routeUnreadDirectMessagesToRunMailbox(
    runId: string,
    directHandle: string
  ): { routedCount: number; hasMore: boolean; types: MessageType[] } {
    const routed = this.messages.filter(
      (message) =>
        message.run_id === runId && message.to_handle === directHandle && message.read === 0
    )
    for (const message of routed) {
      message.to_handle = `run:${runId}`
    }
    return {
      routedCount: routed.length,
      hasMore: false,
      types: [...new Set(routed.map((message) => message.type))]
    }
  }

  areUnreadMessages(toHandle: string, ids: string[]): boolean {
    return ids.every((id) =>
      this.messages.some(
        (message) => message.id === id && message.to_handle === toHandle && message.read === 0
      )
    )
  }

  markAsDelivered(ids: string[]): void {
    const deliveredIds = new Set(ids)
    for (const message of this.messages) {
      if (deliveredIds.has(message.id)) {
        message.delivered_at = '1970-01-01 00:00:00'
      }
    }
    this.clearMailboxPointerEnter(deliveredIds)
  }

  markAsUndelivered(ids: string[]): void {
    const releasedIds = new Set(ids)
    for (const message of this.messages) {
      if (releasedIds.has(message.id) && message.read === 0) {
        message.delivered_at = null
      }
    }
    this.clearMailboxPointerEnter(releasedIds)
  }

  private clearMailboxPointerEnter(ids: ReadonlySet<string>): void {
    for (const message of this.messages) {
      if (ids.has(message.id)) {
        message.pointer_enter_pending = 0
        message.pointer_pty_id = null
        message.pointer_process_incarnation = null
      }
    }
  }

  private advanceMailboxPointerPhase(
    ids: string[],
    target: { ptyId: string; processIncarnation: string },
    from: number,
    to: number
  ): boolean {
    const selected = new Set(ids)
    const advanced = this.messages.filter(
      (message) =>
        selected.has(message.id) &&
        message.read === 0 &&
        message.pointer_enter_pending === from &&
        message.pointer_pty_id === target.ptyId &&
        message.pointer_process_incarnation === target.processIncarnation
    )
    if (advanced.length !== ids.length) {
      return false
    }
    for (const message of advanced) {
      message.pointer_enter_pending = to
    }
    return true
  }

  private matchMailboxPointerEnter(
    ids: string[],
    target: { ptyId: string; processIncarnation: string },
    expectedPhases: readonly number[]
  ): Set<string> {
    return new Set(
      this.messages
        .filter(
          (message) =>
            ids.includes(message.id) &&
            expectedPhases.includes(message.pointer_enter_pending ?? 0) &&
            message.pointer_pty_id === target.ptyId &&
            message.pointer_process_incarnation === target.processIncarnation
        )
        .map((message) => message.id)
    )
  }

  close(): void {}
}
