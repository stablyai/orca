import { isCursorAgentTitle } from '../../../shared/agent-detection'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'

export type OrchestrationMailboxPointerStageDependencies<
  TWaiter extends OrchestrationMessageWaiter
> = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getTabTitle: (tabId: string) => string | null | undefined
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  writePty: (ptyId: string, data: string) => boolean | Promise<boolean>
  lastUserInputAt?: (ptyId: string) => number | undefined
  isOrcaWindowFocused?: () => boolean
  now?: () => number
  scheduleTypingQuietRetry?: (ptyId: string, mailboxHandle: string) => void
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export function stageOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: OrchestrationMailboxPointerStageDependencies<TWaiter>,
  input: {
    leaf: OrchestrationMailboxLeaf
    mailboxHandle: string
    unread: readonly { id: string; type: string; sequence: number }[]
    newestSequence: number
  }
): void {
  const ptyId = input.leaf.ptyId
  if (!ptyId) {
    return
  }
  const flight = deps.state.beginFlight(ptyId)
  let writeResult: boolean | Promise<boolean>
  try {
    writeResult = deps.writePty(
      ptyId,
      formatMessagePointer(input.unread.length, input.mailboxHandle)
    )
  } catch {
    finishOrchestrationMailboxPointerWrite(deps, {
      ...input,
      ptyId,
      flight,
      accepted: false
    })
    return
  }
  if (typeof writeResult === 'boolean') {
    finishOrchestrationMailboxPointerWrite(deps, { ...input, ptyId, flight, accepted: writeResult })
    return
  }
  void writeResult
    .then(
      (accepted) =>
        finishOrchestrationMailboxPointerWrite(deps, { ...input, ptyId, flight, accepted }),
      () =>
        finishOrchestrationMailboxPointerWrite(deps, {
          ...input,
          ptyId,
          flight,
          accepted: false
        })
    )
    .catch(() => undefined)
}

function finishOrchestrationMailboxPointerWrite<TWaiter extends OrchestrationMessageWaiter>(
  deps: OrchestrationMailboxPointerStageDependencies<TWaiter>,
  input: {
    leaf: OrchestrationMailboxLeaf
    mailboxHandle: string
    unread: readonly { id: string; type: string; sequence: number }[]
    newestSequence: number
    ptyId: string
    flight: OrchestrationMailboxDeliveryFlight
    accepted: boolean
  }
): void {
  let delayedSettle = false
  try {
    if (!input.accepted || !deps.state.isCurrentFlight(input.ptyId, input.flight)) {
      return
    }
    const db = deps.getDb()
    if (
      !db ||
      shouldReleaseOrchestrationPointer(
        db,
        input.mailboxHandle,
        input.unread,
        deps.getMessageWaiters(input.mailboxHandle)
      )
    ) {
      return
    }
    input.flight.stagedMessageIds = input.unread.map((message) => message.id)
    db.markAsDelivered(input.flight.stagedMessageIds)
    deps.state.setWatermark(
      input.mailboxHandle,
      input.newestSequence,
      input.ptyId,
      deps.getLeafKey(input.leaf.tabId, input.leaf.leafId)
    )
    if (
      [input.leaf.lastOscTitle, input.leaf.paneTitle, deps.getTabTitle(input.leaf.tabId)].some(
        isCursorAgentTitle
      )
    ) {
      deps.state.clearWatermark(input.mailboxHandle, input.newestSequence, input.ptyId)
      deps.redrive(input.mailboxHandle)
      return
    }
    input.flight.enterTimer = setTimeout(
      () =>
        submitOrchestrationMailboxPointer(deps, {
          leaf: input.leaf,
          mailboxHandle: input.mailboxHandle,
          messages: input.unread,
          newestSequence: input.newestSequence,
          ptyId: input.ptyId,
          flight: input.flight
        }),
      500
    )
    delayedSettle = true
  } finally {
    if (!delayedSettle) {
      deps.settle(input.ptyId, input.flight)
    }
  }
}
