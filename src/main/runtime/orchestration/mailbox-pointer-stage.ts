import { isCursorAgentTitle } from '../../../shared/agent-detection'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import { isStatuslessIdleProofCurrent } from './mailbox-statusless-idle-proof'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState,
  OrchestrationStatuslessIdleProof
} from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import {
  submitStatuslessCodexMailboxPointer,
  type SubmitStatuslessCodexPointer
} from './mailbox-statusless-codex-submit'

/** Delay between the pointer text landing in the composer and the submit keystroke. */
const POINTER_SUBMIT_DELAY_MS = 500

type PointerStageDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getTabTitle: (tabId: string) => string | null | undefined
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  requestSleepingRecipientWake?: (mailboxHandle: string) => void
  submitStatuslessCodexPointer?: SubmitStatuslessCodexPointer
  deferRedriveUntilPtyOutput?: (ptyId: string, mailboxHandle: string, sequence: number) => boolean
  clearDeferredOutputRedrive?: (ptyId: string, mailboxHandle: string, sequence: number) => void
  writePty: (ptyId: string, data: string) => boolean | Promise<boolean>
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

type PointerStageInput = {
  leaf: OrchestrationMailboxLeaf
  mailboxHandle: string
  unread: readonly { id: string; type: string; sequence: number }[]
  newestSequence: number
  statuslessIdleProof?: OrchestrationStatuslessIdleProof
}

/** Write the pointer text into the recipient's composer, then arm its submit. */
export function stageOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: PointerStageDependencies<TWaiter>,
  input: PointerStageInput
): void {
  const ptyId = input.leaf.ptyId
  if (
    !ptyId ||
    (input.statuslessIdleProof &&
      !isStatuslessIdleProofCurrent(
        input.leaf,
        input.statuslessIdleProof,
        deps.getTerminalProcessIncarnation
      ))
  ) {
    return
  }
  if (
    input.statuslessIdleProof &&
    deps.submitStatuslessCodexPointer &&
    deps.deferRedriveUntilPtyOutput &&
    deps.clearDeferredOutputRedrive
  ) {
    submitStatuslessCodexMailboxPointer(
      {
        mailboxOwner: deps.mailboxOwner,
        state: deps.state,
        getDb: deps.getDb,
        getLeaf: deps.getLeaf,
        getLeafKey: deps.getLeafKey,
        getMessageWaiters: deps.getMessageWaiters,
        getTerminalProcessIncarnation: deps.getTerminalProcessIncarnation,
        submitStatuslessCodexPointer: deps.submitStatuslessCodexPointer,
        deferRedriveUntilPtyOutput: deps.deferRedriveUntilPtyOutput,
        clearDeferredOutputRedrive: deps.clearDeferredOutputRedrive,
        settle: deps.settle,
        redrive: deps.redrive
      },
      {
        leaf: input.leaf,
        mailboxHandle: input.mailboxHandle,
        unread: input.unread,
        newestSequence: input.newestSequence,
        statuslessIdleProof: input.statuslessIdleProof
      }
    )
    return
  }
  const flight = deps.state.beginFlight(ptyId)
  const writeResult = deps.writePty(
    ptyId,
    formatMessagePointer(input.unread.length, input.mailboxHandle)
  )
  if (typeof writeResult === 'boolean') {
    finishPointerWrite(deps, input, ptyId, flight, writeResult)
    return
  }
  void writeResult
    .then(
      (accepted) => finishPointerWrite(deps, input, ptyId, flight, accepted),
      () => finishPointerWrite(deps, input, ptyId, flight, false)
    )
    .catch(() => undefined)
}

function finishPointerWrite<TWaiter extends OrchestrationMessageWaiter>(
  deps: PointerStageDependencies<TWaiter>,
  input: PointerStageInput,
  ptyId: string,
  flight: OrchestrationMailboxDeliveryFlight,
  accepted: boolean
): void {
  const { leaf, mailboxHandle, unread, newestSequence } = input
  let delayedSettle = false
  try {
    if (!accepted || !deps.state.isCurrentFlight(ptyId, flight)) {
      return
    }
    const currentLeaf = deps.getLeaf(deps.getLeafKey(leaf.tabId, leaf.leafId))
    if (
      input.statuslessIdleProof &&
      (!currentLeaf ||
        !isStatuslessIdleProofCurrent(
          currentLeaf,
          input.statuslessIdleProof,
          deps.getTerminalProcessIncarnation
        ))
    ) {
      return
    }
    const db = deps.getDb()
    if (
      !db ||
      shouldReleaseOrchestrationPointer(
        db,
        mailboxHandle,
        unread,
        deps.getMessageWaiters(mailboxHandle)
      )
    ) {
      return
    }
    flight.stagedMessageIds = unread.map((message) => message.id)
    db.markAsDelivered(flight.stagedMessageIds)
    deps.state.setWatermark(
      mailboxHandle,
      newestSequence,
      ptyId,
      deps.getLeafKey(leaf.tabId, leaf.leafId)
    )
    if (
      [leaf.lastOscTitle, leaf.paneTitle, deps.getTabTitle(leaf.tabId)].some(isCursorAgentTitle)
    ) {
      deps.state.clearWatermark(mailboxHandle, newestSequence, ptyId)
      deps.redrive(mailboxHandle)
      return
    }
    flight.enterTimer = setTimeout(
      () =>
        submitOrchestrationMailboxPointer(deps, {
          leaf,
          mailboxHandle,
          messages: unread,
          newestSequence,
          ptyId,
          flight,
          statuslessIdleProof: input.statuslessIdleProof
        }),
      POINTER_SUBMIT_DELAY_MS
    )
    delayedSettle = true
  } finally {
    if (!delayedSettle) {
      deps.settle(ptyId, flight)
    }
  }
}
