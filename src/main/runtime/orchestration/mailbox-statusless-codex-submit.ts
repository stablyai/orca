import { formatMessagePointer } from './formatter'
import type { OrchestrationDb } from './db'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import { isStatuslessIdleProofProcessCurrent } from './mailbox-statusless-idle-proof'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState,
  OrchestrationStatuslessIdleProof
} from './mailbox-pointer-state'

export type SubmitStatuslessCodexPointer = (
  terminalHandle: string,
  ptyId: string,
  prompt: string,
  beforeWrite: (ptyId: string) => void | Promise<void>,
  afterWrite: (ptyId: string) => void | Promise<void>
) => Promise<void>

type StatuslessCodexSubmitDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  submitStatuslessCodexPointer: SubmitStatuslessCodexPointer
  deferRedriveUntilPtyOutput: (ptyId: string, mailboxHandle: string, sequence: number) => boolean
  clearDeferredOutputRedrive: (ptyId: string, mailboxHandle: string, sequence: number) => void
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

type StatuslessCodexSubmitInput = {
  leaf: OrchestrationMailboxLeaf
  mailboxHandle: string
  unread: readonly { id: string; type: string; sequence: number }[]
  newestSequence: number
  statuslessIdleProof: OrchestrationStatuslessIdleProof
}

type TargetState = 'current' | 'blocked' | 'invalid' | 'released'

/** Submit a proven statusless Codex pointer through the guarded agent-prompt path. */
export function submitStatuslessCodexMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: StatuslessCodexSubmitDependencies<TWaiter>,
  input: StatuslessCodexSubmitInput
): void {
  const ptyId = input.leaf.ptyId
  if (!ptyId) {
    return
  }
  const flight = deps.state.beginFlight(ptyId)
  deps.state.setWatermark(
    input.mailboxHandle,
    input.newestSequence,
    ptyId,
    deps.getLeafKey(input.leaf.tabId, input.leaf.leafId)
  )
  let submitted = false
  let clearAndRedrive = false
  let releaseWithoutRedrive = false
  let deferredUntilOutput = false
  let promptWriteAccepted = false
  let finalizeReservation = true
  void Promise.resolve()
    .then(() =>
      deps.submitStatuslessCodexPointer(
        input.statuslessIdleProof.terminalHandle,
        ptyId,
        formatMessagePointer(input.unread.length, input.mailboxHandle),
        (writePtyId) => {
          if (writePtyId !== ptyId || targetState(deps, input, ptyId, flight) !== 'current') {
            throw new Error('orchestration_pointer_target_changed')
          }
        },
        () => {
          promptWriteAccepted = true
        }
      )
    )
    .then(() => {
      if (!deps.state.isCurrentFlight(ptyId, flight)) {
        finalizeReservation = false
        return
      }
      const state = targetState(deps, input, ptyId, flight, true)
      if (state === 'invalid') {
        clearAndRedrive = true
      } else if (state === 'released') {
        releaseWithoutRedrive = true
      } else if (state === 'current') {
        const messageIds = input.unread.map((message) => message.id)
        deps.getDb()?.markAsDelivered(messageIds)
        flight.stagedMessageIds = messageIds
        submitted = true
      }
    })
    .catch(() => {
      if (!deps.state.isCurrentFlight(ptyId, flight)) {
        finalizeReservation = false
        return
      }
      const state = targetState(deps, input, ptyId, flight)
      clearAndRedrive = state === 'invalid'
      releaseWithoutRedrive = state === 'released'
      deferredUntilOutput =
        state === 'current' &&
        !promptWriteAccepted &&
        deps.deferRedriveUntilPtyOutput(ptyId, input.mailboxHandle, input.newestSequence)
    })
    .finally(() => {
      let released = false
      if (finalizeReservation) {
        released =
          submitted || clearAndRedrive || releaseWithoutRedrive || deferredUntilOutput
            ? deps.state.clearWatermark(input.mailboxHandle, input.newestSequence, ptyId)
            : deps.state.deactivateWatermark(input.mailboxHandle, input.newestSequence, ptyId)
      }
      if (submitted) {
        deps.clearDeferredOutputRedrive(ptyId, input.mailboxHandle, input.newestSequence)
      }
      deps.settle(ptyId, flight)
      if (released && clearAndRedrive) {
        deps.redrive(input.mailboxHandle, true)
      }
    })
}

function targetState<TWaiter extends OrchestrationMessageWaiter>(
  deps: StatuslessCodexSubmitDependencies<TWaiter>,
  input: StatuslessCodexSubmitInput,
  ptyId: string,
  flight: OrchestrationMailboxDeliveryFlight,
  allowActiveStatus = false
): TargetState {
  if (!deps.state.isCurrentFlight(ptyId, flight)) {
    return 'invalid'
  }
  const leaf = deps.getLeaf(deps.getLeafKey(input.leaf.tabId, input.leaf.leafId))
  if (
    !leaf ||
    leaf.ptyId !== ptyId ||
    !leaf.writable ||
    deps.mailboxOwner.resolve(leaf) !== input.mailboxHandle ||
    !isStatuslessIdleProofProcessCurrent(
      leaf,
      input.statuslessIdleProof,
      deps.getTerminalProcessIncarnation
    )
  ) {
    return 'invalid'
  }
  if (
    !allowActiveStatus &&
    (leaf.lastAgentStatus === 'working' || leaf.lastAgentStatus === 'permission')
  ) {
    return 'blocked'
  }
  if (
    shouldReleaseOrchestrationPointer(
      deps.getDb(),
      input.mailboxHandle,
      input.unread,
      deps.getMessageWaiters(input.mailboxHandle)
    )
  ) {
    return 'released'
  }
  return 'current'
}
