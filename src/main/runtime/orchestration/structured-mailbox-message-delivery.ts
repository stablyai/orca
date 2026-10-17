import type { MessageRow, OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { SenderNameResolver } from './agent-message-sender'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerTarget,
  StructuredPointerSessionFacts
} from './structured-mailbox-pointer-delivery'
import {
  resolveStructuredMailOperation,
  type StructuredMailSubmissionIndex
} from './structured-pointer-operation-id'
import {
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredPointerRetainReason
} from './structured-session-pointer-delivery'
import { structuredMailBody } from './structured-mail-source'
import type { StructuredMailOperationOwner } from './structured-mail-operation-owners'

/** Sends one message, or replays its send; false when the pass must stop here (the session cannot
 *  take any, or a prompt waits on the person and later mail must not overtake this one). */
export async function sendStructuredMailboxMessage(
  db: OrchestrationDb,
  mailboxHandle: string,
  target: StructuredPointerTarget,
  message: MessageRow,
  attempt: {
    key: string
    session: StructuredPointerSessionFacts
    submissionIndex: StructuredMailSubmissionIndex
    contextClearOperationId: string | undefined
    fence: number
    retain: (reason: StructuredPointerRetainReason) => void
    answered: (attached?: boolean) => void
    isCurrent: () => boolean
    isEligible: (message: MessageRow) => boolean
  },
  deps: {
    host: StructuredMailboxPointerHost
    senderName: SenderNameResolver
    getCliCommand: () => OrchestrationCliCommand
    mintedOperations: Map<string, StructuredMailOperationOwner>
  }
): Promise<boolean> {
  let owner = deps.mintedOperations.get(attempt.key)
  const resolved = resolveStructuredMailOperation({
    messageId: message.id,
    submissions: attempt.session.submissions,
    submissionIndex: attempt.submissionIndex,
    mintedByThisProcess: owner
  })
  if (resolved.kind === 'park') {
    attempt.retain('turn-unsettled')
    return true
  }
  if (resolved.kind === 'send') {
    owner = {
      ...resolved.operation,
      sessionId: target.sessionId,
      contextClearOperationId: attempt.contextClearOperationId,
      mailboxHandle,
      messageId: message.id
    }
    deps.mintedOperations.set(attempt.key, owner)
    const send = () =>
      deps.host.send({
        sessionId: target.sessionId,
        dispatchId: target.dispatchId,
        operationId: resolved.operation.operationId,
        expectedRuntimeFence: attempt.fence,
        body: structuredMailBody({
          db,
          mailboxHandle,
          dispatchId: target.dispatchId,
          message,
          senderName: deps.senderName,
          cliCommand: deps.getCliCommand()
        }),
        onAnswered: attempt.answered
      })
    let outcome = await send()
    // Nothing is recorded for a held send, so the same id is safe to retry once the prompt clears.
    while (outcome.kind === 'held') {
      if (!attempt.isCurrent()) {
        return false
      }
      if (!attempt.isEligible(message)) {
        return true
      }
      if (deps.host.hasActionablePromptNow(target.sessionId) !== false) {
        break
      }
      outcome = await send()
    }
    if (outcome.kind === 'held') {
      attempt.retain('turn-unsettled')
      return false
    }
    if (outcome.kind === 'unattached') {
      attempt.retain('session-not-attached')
      return false
    }
    // A queued message is the chat's queue's to send, as a person's queued message is.
    if (outcome.kind === 'sent' && !structuredDispatchDelivered(outcome.state)) {
      // Resending under its id replays this verdict and starts nothing.
      attempt.retain(retainReasonForDispatch(outcome.state))
      return true
    }
  }
  // Sent, queued, or a send this lane gave up waiting on that ran after all.
  db.markAsReadAndDelivered([message.id])
  if (deps.mintedOperations.get(attempt.key) === owner) {
    deps.mintedOperations.delete(attempt.key)
  }
  return true
}

/** One page admits in order, advancing on host answer rather than provider consumption. */
export async function sendStructuredMailboxPage(input: {
  db: OrchestrationDb
  mailboxHandle: string
  target: StructuredPointerTarget
  unread: readonly MessageRow[]
  session: StructuredPointerSessionFacts
  contextClearOperationId: string | undefined
  submissionIndex: StructuredMailSubmissionIndex
  fence: number
  isCurrent: () => boolean
  isEligible: (message: MessageRow) => boolean
  retain: (reason: StructuredPointerRetainReason) => void
  prune: (key?: string) => void
  host: StructuredMailboxPointerHost
  senderName: SenderNameResolver
  getCliCommand: () => OrchestrationCliCommand
  mintedOperations: Map<string, StructuredMailOperationOwner>
  sendsInFlight: Map<string, StructuredPointerTarget>
}): Promise<boolean> {
  const {
    db,
    mailboxHandle,
    target,
    unread,
    session,
    contextClearOperationId,
    submissionIndex,
    fence,
    isCurrent
  } = input
  const sessionId = target.sessionId
  // Oldest first, each its own send. The next is issued once the host has answered this one,
  // never after the agent takes it in; one in doubt does not hold back the ones after it, but one
  // held for a waiting prompt stops the pass so later mail cannot overtake it.
  for (const message of unread) {
    if (!isCurrent()) {
      return false
    }
    if (!input.isEligible(message)) {
      continue
    }
    const key = JSON.stringify([sessionId, contextClearOperationId ?? null, message.id])
    if (input.sendsInFlight.has(key)) {
      continue
    }
    let answered = (_attached?: boolean): void => undefined
    const issued = new Promise<boolean>((resolve) => {
      answered = (attached = true) => resolve(attached)
    })
    const retain = (reason: StructuredPointerRetainReason) => {
      if (input.sendsInFlight.get(key) === target) {
        input.retain(reason)
      }
    }
    input.sendsInFlight.set(key, target)
    const outcome = sendStructuredMailboxMessage(
      db,
      mailboxHandle,
      target,
      message,
      {
        key,
        session,
        fence,
        retain,
        answered,
        isCurrent,
        isEligible: input.isEligible,
        contextClearOperationId,
        submissionIndex
      },
      {
        host: input.host,
        senderName: input.senderName,
        getCliCommand: input.getCliCommand,
        mintedOperations: input.mintedOperations
      }
    )
      .catch(() => {
        retain(retainReasonForDispatch('unknown'))
        return true
      })
      .finally(() => {
        if (input.sendsInFlight.get(key) === target) {
          input.sendsInFlight.delete(key)
        }
        input.prune(key)
      })
    // What settles after this pass is its own: nothing awaits it once issued.
    outcome.catch(() => undefined)
    if (!(await Promise.race([issued, outcome]))) {
      return false
    }
  }
  return true
}
