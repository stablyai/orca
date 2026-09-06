import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  claudeHasReplayContent,
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'
import {
  claudeDispatchContentKey,
  claudeDispatchMessageContent
} from './claude-structured-dispatch-content'

const MAX_RETIRED_DISPATCH_WAITERS = 64

export function resolveClaudeReplayWaiter(
  session: ClaudeSession,
  message: Record<string, unknown>
): boolean {
  const envelope = readClaudeMessageEnvelope(message)
  const isUserReplay =
    envelope?.role === 'user' &&
    message.parent_tool_use_id === null &&
    claudeHasReplayContent(envelope)
  const isCompletedCommand = message.type === 'result'
  if (
    (!isUserReplay && !isCompletedCommand) ||
    readClaudeFrameString(message, 'session_id') !== session.providerSessionId
  ) {
    return false
  }
  const uuid = readClaudeFrameString(message, 'uuid')
  if (!uuid) {
    return false
  }

  // Newer SDK frames carry the client uuid that caused a turn. A correlation
  // value is authoritative: never fall back to queue order or content, since
  // identical prompts may be in flight across a timeout boundary.
  const userMessageUuid = readClaudeFrameString(message, 'user_message_uuid')
  if (userMessageUuid) {
    const exact = session.dispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (exact) {
      settleWaiter(session, exact, uuid)
      return isUserReplay && exact.dispatchSequence === session.dispatchSequence
    }
    const retired = session.retiredDispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (retired) {
      forgetRetiredWaiter(session, retired)
      return recoverLateIdentity(session, retired, uuid, isUserReplay)
    }
    return false
  }

  const exact = session.dispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (exact) {
    settleWaiter(session, exact, uuid)
    return isUserReplay && exact.dispatchSequence === session.dispatchSequence
  }
  const retired = session.retiredDispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (retired) {
    forgetRetiredWaiter(session, retired)
    return recoverLateIdentity(session, retired, uuid, isUserReplay)
  }

  if (isUserReplay) {
    // Compatibility CLIs may mint a new replay uuid instead of echoing the
    // client uuid. Content is an acceptable join only when it is the sole
    // candidate on one side of the timeout boundary; with active and retired
    // candidates present, identical prompts are intentionally left unknown.
    const replayContentKey = claudeDispatchContentKey(envelope.content)
    if (!session.replayContentFallbackBlocked && session.retiredDispatchWaiters.length === 0) {
      const compatible = session.dispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (compatible.length === 1) {
        settleWaiter(session, compatible[0]!, uuid)
        return compatible[0]!.dispatchSequence === session.dispatchSequence
      }
    } else if (!session.replayContentFallbackBlocked && session.dispatchWaiters.length === 0) {
      const lateCompatible = session.retiredDispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (lateCompatible.length === 1) {
        const [candidate] = lateCompatible
        forgetRetiredWaiter(session, candidate!)
        return recoverLateIdentity(session, candidate!, uuid, true)
      }
    }
    return false
  }
  const current = session.dispatchWaiters[0]
  if (isCompletedCommand && !current?.acceptsResult) {
    return false
  }
  // A legacy result has no dispatch correlation. Any retired waiter makes queue order ambiguous,
  // even when the retired dispatch was an ordinary turn rather than a slash command.
  if (isCompletedCommand && session.retiredDispatchWaiters.length > 0) {
    return false
  }
  // Once an eviction occurred, a fresh result uuid cannot be joined to a waiter by queue order.
  if (isCompletedCommand && session.replayContentFallbackBlocked) {
    return false
  }
  const waiter = uuid ? session.dispatchWaiters.shift() : undefined
  if (waiter && uuid) {
    clearTimeout(waiter.timer)
    waiter.settledUuid = uuid
    waiter.resolve(uuid)
    return isUserReplay
  }
  return false
}

function settleWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter, uuid: string): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
  clearTimeout(waiter.timer)
  waiter.settledUuid = uuid
  waiter.resolve(uuid)
}

function forgetRetiredWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.retiredDispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.retiredDispatchWaiters.splice(index, 1)
  }
}

function recoverLateIdentity(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  isUserReplay: boolean
): boolean {
  if (!isUserReplay && !waiter.acceptsResult) {
    return false
  }
  if (waiter.dispatchSequence === session.dispatchSequence) {
    session.activeTurnId = uuid
    session.activeTurnSequence = waiter.dispatchSequence
  }
  return isUserReplay && waiter.dispatchSequence === session.dispatchSequence
}

function waitForReplay(
  session: ClaudeSession,
  timeoutMs: number,
  acceptsResult: boolean,
  sentUuid: string,
  replayContentKey: string
): { waiter: ClaudeDispatchWaiter; promise: Promise<string | null> } {
  let waiter!: ClaudeDispatchWaiter
  const promise = new Promise<string | null>((resolve) => {
    waiter = {
      acceptsResult,
      sentUuid,
      dispatchSequence: session.dispatchSequence,
      replayContentKey,
      resolve,
      timer: setTimeout(() => {
        const index = session.dispatchWaiters.indexOf(waiter)
        if (index !== -1) {
          session.dispatchWaiters.splice(index, 1)
        }
        retireWaiter(session, waiter)
        resolve(null)
      }, timeoutMs)
    }
    waiter.timer.unref?.()
    session.dispatchWaiters.push(waiter)
  })
  return { waiter, promise }
}

function retireWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
  clearTimeout(waiter.timer)
  if (!waiter.retired) {
    waiter.retired = true
    session.retiredDispatchWaiters.push(waiter)
    if (session.retiredDispatchWaiters.length > MAX_RETIRED_DISPATCH_WAITERS) {
      session.replayContentFallbackBlocked = true
      session.retiredDispatchWaiters.splice(
        0,
        session.retiredDispatchWaiters.length - MAX_RETIRED_DISPATCH_WAITERS
      )
    }
  }
}

export async function dispatchClaudeTurn(
  session: ClaudeSession,
  input: { clientMessageId: string; body: AgentJournalMessageItem },
  timeoutMs: number
): Promise<AgentSessionDispatchOutcome> {
  let content: unknown[]
  try {
    content = await claudeDispatchMessageContent(input.body)
  } catch (error) {
    return { state: 'rejected', reason: (error as Error).message }
  }
  const dispatchSequence = ++session.dispatchSequence
  const acceptsResult = input.body.blocks.some(
    (block) => block.type === 'text' && block.text.trimStart().startsWith('/')
  )
  const sentUuid = randomUUID()
  const replay = waitForReplay(
    session,
    timeoutMs,
    acceptsResult,
    sentUuid,
    claudeDispatchContentKey(content)
  )
  const replayed = replay.promise
  try {
    await session.connection.send({
      type: 'user',
      uuid: sentUuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.providerSessionId
    })
  } catch (error) {
    const waiter = replay.waiter
    if (waiter.settledUuid) {
      const uuid = await replayed
      if (uuid) {
        session.activeTurnId = uuid
        session.activeTurnSequence = dispatchSequence
        return {
          state: 'accepted',
          providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
        }
      }
    }
    if (!waiter.retired) {
      retireWaiter(session, waiter)
      waiter.resolve(null)
    }
    return { state: 'unknown', reason: (error as Error).message }
  }
  const uuid = await replayed
  if (uuid) {
    session.activeTurnId = uuid
    session.activeTurnSequence = dispatchSequence
  }
  return uuid
    ? {
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
      }
    : { state: 'unknown', reason: 'claude accepted a message but did not replay its uuid in time' }
}
