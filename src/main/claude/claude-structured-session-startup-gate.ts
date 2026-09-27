// A Claude session is published once its child is spawned, before the CLI has answered
// initialize. Prompts sent in that window are held here and written, in order, once startup
// lands (init facts read and saved options restored), so a first turn never runs under
// defaults the restore was about to replace. A held prompt was never written, so a startup
// that fails rejects it rather than leaving its delivery in doubt.

import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import { dispatchWriteFailureReason } from '../../shared/structured-agent-session-dispatch-rejection'
import { providerStartupFailureRejection } from '../native-chat/agent-session-wire/structured-agent-session-dead-generation-settlement'
import { claudeUserMessageWasProvablyUnwritten } from './claude-agent-sdk-user-message-queue'
import {
  forgetRetiredWaiter,
  forgetWaiter,
  retireWaiter
} from './claude-structured-dispatch-waiters'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome,
  ClaudeSession
} from './claude-structured-session-state'

type ClaudeStartupHeldWrite = {
  waiter: ClaudeDispatchWaiter
  message: Record<string, unknown>
  settleLate?: (outcome: ClaudeLateDispatchOutcome) => void
}

export type ClaudeSessionStartupGate = {
  state: 'pending' | 'proven' | 'failed'
  held: ClaudeStartupHeldWrite[]
  /** Held prompts are still being written; later prompts must queue behind them. */
  draining: boolean
  failure: Error | null
  /** Resolves once startup has landed or faulted the session; never rejects. */
  settled: Promise<void>
}

export function createClaudeSessionStartupGate(): ClaudeSessionStartupGate {
  return { state: 'pending', held: [], draining: false, failure: null, settled: Promise.resolve() }
}

export function claudeStartupFailureReason(session: ClaudeSession): string | null {
  return session.startup.state === 'failed'
    ? providerStartupFailureRejection(session.startup.failure ?? undefined)
    : null
}

/** Resolves when startup lands or `timeoutMs` passes; a stuck start then refuses the write as before. */
export function claudeStartupSettledWithin(
  session: ClaudeSession | undefined,
  timeoutMs: number
): Promise<void> {
  if (session?.startup.state !== 'pending') {
    return Promise.resolve()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    session.startup.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

export function claudeStartupHoldsWrites(session: ClaudeSession): boolean {
  return session.startup.state === 'pending' || session.startup.draining
}

/** Admits a prompt while startup is pending; it is written when `openClaudeStartupGate` runs. */
export async function holdClaudeStartupWrite(
  session: ClaudeSession,
  input: {
    message: Record<string, unknown>
    arm: () => { waiter: ClaudeDispatchWaiter }
    beforeDispatch?: () => Promise<void>
    settleLate?: (outcome: ClaudeLateDispatchOutcome) => void
  }
): Promise<AgentSessionDispatchOutcome> {
  if (input.beforeDispatch) {
    try {
      await input.beforeDispatch()
    } catch (error) {
      if (error instanceof AgentSessionPreDispatchError) {
        throw error
      }
      return { state: 'rejected', reason: dispatchWriteFailureReason(error) }
    }
  }
  // Startup may have failed while the admission barrier ran.
  const failed = claudeStartupFailureReason(session)
  if (failed) {
    return { state: 'rejected', reason: failed }
  }
  const { waiter } = input.arm()
  session.startup.held.push({
    waiter,
    message: input.message,
    ...(input.settleLate ? { settleLate: input.settleLate } : {})
  })
  // Startup finished writing what it held while the barrier ran; nothing else would drain this.
  if (!claudeStartupHoldsWrites(session)) {
    void drainClaudeStartupWrites(session)
  }
  return { state: 'admitted' }
}

export async function openClaudeStartupGate(session: ClaudeSession): Promise<void> {
  const gate = session.startup
  if (gate.state !== 'pending') {
    return
  }
  gate.state = 'proven'
  await drainClaudeStartupWrites(session)
}

async function drainClaudeStartupWrites(session: ClaudeSession): Promise<void> {
  const gate = session.startup
  gate.draining = true
  try {
    for (let held = gate.held.shift(); held; held = gate.held.shift()) {
      await writeHeld(session, held)
    }
  } finally {
    gate.draining = false
  }
}

async function writeHeld(session: ClaudeSession, held: ClaudeStartupHeldWrite): Promise<void> {
  try {
    await session.connection.send(held.message)
  } catch (error) {
    if (held.waiter.settledUuid) {
      return
    }
    if (claudeUserMessageWasProvablyUnwritten(error)) {
      rejectHeld(session, held, dispatchWriteFailureReason(error))
      return
    }
    // Possibly written: only a replay or the child's exit can settle it now.
    retireWaiter(session, held.waiter)
    held.waiter.resolve(null)
  }
}

function rejectHeld(session: ClaudeSession, held: ClaudeStartupHeldWrite, reason: string): void {
  forgetWaiter(session, held.waiter)
  forgetRetiredWaiter(session, held.waiter)
  held.waiter.resolve(null)
  if (held.waiter.clientMessageId) {
    held.settleLate?.({ clientMessageId: held.waiter.clientMessageId, state: 'rejected', reason })
  }
}

/** Rejects every held prompt with `reason`; true when any was held. */
export function rejectClaudeStartupWrites(session: ClaudeSession, reason: string): boolean {
  const held = session.startup.held.splice(0)
  for (const entry of held) {
    rejectHeld(session, entry, reason)
  }
  return held.length > 0
}

/** Startup cannot land any more; nothing held was written, so all of it is rejected. */
export function failClaudeStartupGate(session: ClaudeSession, error: Error): void {
  const gate = session.startup
  if (gate.state === 'pending') {
    gate.state = 'failed'
    gate.failure = error
  }
  rejectClaudeStartupWrites(session, providerStartupFailureRejection(error))
}
