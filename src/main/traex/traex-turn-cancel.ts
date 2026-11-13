import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionStopOutcome } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-stop'
import type { TraexSession } from './traex-session'
import { pauseTraexThreadGoal } from './traex-thread-goal'

export async function cancelTraexTurn(
  session: TraexSession,
  input: Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
): ReturnType<StructuredAgentSessionAdapter['cancelTurn']> {
  const journalTurn = session.timeline?.openTurnId
  if (input.turnId && input.turnId !== journalTurn) {
    return { cancelled: false }
  }
  const facts: AgentSessionStopOutcome = {
    pause: 'unconfirmed',
    interrupt: 'not-needed',
    root: 'unproven',
    workload: 'unproven',
    errors: []
  }
  let paused = false
  const pause = async () => {
    try {
      paused = (await pauseTraexThreadGoal(session)) || paused
      facts.pause = paused ? 'acknowledged' : 'not-needed'
    } catch (error) {
      facts.pause = 'unconfirmed'
      facts.errors.push(error)
    }
  }
  await pause()
  let cancelled = paused
  const native = session.activeTurn
  if (native) {
    try {
      await session.connection.request(
        'turn/interrupt',
        { threadId: session.threadId, turnId: native },
        { timeoutMs: 5_000 }
      )
      session.prompts?.withdraw()
      cancelled = true
      facts.interrupt = 'accepted'
    } catch (error) {
      facts.interrupt = 'unconfirmed'
      facts.errors.push(error)
    }
  } else if (session.pending.size > 0) {
    cancelled ||= await session.close()
  }
  if (facts.pause !== 'not-needed') {
    await pause()
  }
  return { cancelled, ...(journalTurn ? { turnId: journalTurn } : {}), stop: facts }
}
