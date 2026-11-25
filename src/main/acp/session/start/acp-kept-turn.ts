import { providerTimelineTurnKeyPart } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import { ACP_PROMPT_TURN_PREFIX, acpTurnEndEvents } from '../../timeline/acp-prompt-turns'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { isStructuredAgentSessionCommandTurnId } from '../../../native-chat/agent-session-wire/operations/structured-agent-session-command-turn'
import type { StructuredAgentSessionCommandRun } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  ACP_OPTION_WRITE_TIMEOUT_MS,
  type AcpStructuredSessionAdapterDeps
} from '../acp-structured-session-adapter-deps'
import { applyAcpLivePermissionMode } from '../../options/acp-live-permission-mode'
import { carryKeptAcpBackgroundWork } from './acp-kept-background-work'
import { assertAcpStartingSession, type AcpStructuredChild } from '../children/acp-structured-child'

/** The translator's turn from the journal's spelling of its id; null for host turns and for ids
 *  too long to have been kept whole. */
function providerTurn(turnId: string): string | null {
  const part = providerTimelineTurnKeyPart(turnId)
  if (part === null || part.includes('#')) {
    return null
  }
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** The message that opened a chat's running prompt turn; null for other turns. */
function promptClientMessageId(turn: string | null): string | null {
  return turn?.startsWith(ACP_PROMPT_TURN_PREFIX) ? turn.slice(ACP_PROMPT_TURN_PREFIX.length) : null
}

/** The host's `/compact` turn as it saved it, so the compaction's answer settles it as usual. */
async function savedCommandRun(
  child: AcpStructuredChild,
  turnId: string
): Promise<StructuredAgentSessionCommandRun | null> {
  const clientMessageId = turnId.slice('compact:'.length)
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  const saved = await child.events
    ?.journalHistory?.()
    ?.readInOrder((reads) => reads.itemDetail(turn.itemId))
    .catch(() => null)
  const running = saved?.body
  return running?.kind === 'turn' && running.state === 'running'
    ? {
        clientMessageId,
        turnId: turn.turnId,
        identity: turn.identity,
        resultIdentity: turn.resultIdentity,
        running
      }
    : null
}

/**
 * After a kept agent's chat opened: the prompt or `/compact` turn the earlier app left running
 * carries on (the agent's answer to that prompt ends it), then the output held since the last ack is let through in order.
 */
export async function carryOnKeptAcpAgent<Opened>(
  opened: Opened,
  child: AcpStructuredChild,
  deps: Pick<
    AcpStructuredSessionAdapterDeps,
    'keptWork' | 'spec' | 'optionWriteTimeoutMs' | 'logger'
  >,
  signal: AbortSignal
): Promise<Opened> {
  const { kept } = child.connection
  if (!kept) {
    return opened
  }
  const work = (await deps.keptWork?.(child.sessionId).catch(() => null)) ?? null
  const turnId = work?.turnId ?? null
  const turn = turnId === null ? null : providerTurn(turnId)
  assertAcpStartingSession(child, () => signal.aborted)
  // Before any turn opens here: these calls belong to turns that already ended.
  await carryKeptAcpBackgroundWork(child, deps.spec.agent)
  // The agent runs the mode it had when the last app let go; the chat's own, picked since, is
  // written live as a pick on a running chat is, without holding the reattach.
  if (child.spec.permissionModeConfig && child.permission !== 'own' && !kept.agentExited) {
    const timeoutMs = deps.optionWriteTimeoutMs ?? ACP_OPTION_WRITE_TIMEOUT_MS
    void applyAcpLivePermissionMode(child, child.permission, { timeoutMs }).catch(
      (error: unknown) =>
        deps.logger?.warn('writing the chat\u2019s mode to a kept agent failed', {
          scope: 'kept-permission',
          sessionId: child.sessionId,
          error
        })
    )
  }
  const command =
    turnId !== null && isStructuredAgentSessionCommandTurnId(turnId)
      ? await savedCommandRun(child, turnId)
      : null
  assertAcpStartingSession(child, () => signal.aborted)
  // A prompt the agent still owes with no turn saved yet (the earlier app quit before the agent
  // began it) carries on as the send it was.
  const unopened = turnId === null && kept.owesPrompt ? (work?.unansweredSendId ?? null) : null
  const clientMessageId = command?.clientMessageId ?? unopened ?? promptClientMessageId(turn)
  if (clientMessageId !== null && child.turns && !child.turns.running) {
    if (command) {
      child.lane?.beginCommand(command)
    }
    const journaled = unopened === null
    // Output is acked only past an open message's or call's start, so the replay rewrites each row
    // whole; a turn whose first lines were acked anyway (the daemon's cap) numbers rows anew.
    const renumber = journaled && !kept.promptReplayedWhole
    const answered = () => kept.earlierPrompt()
    child.turns.adoptEarlier(clientMessageId, answered, command?.turnId, journaled, renumber)
  } else {
    // A turn the agent began itself, which this run's translator doesn't know: it ends as the open
    // app ends one when the agent goes quiet, and the agent's further work opens a turn of its own.
    const { lane } = child
    if (turn !== null && clientMessageId === null && lane) {
      const at = Date.now()
      lane.apply(
        acpTurnEndEvents(lane.translator.providerSessionId, turn, { stopReason: 'end_turn', at })
      )
    }
  }
  kept.releaseOutput()
  return opened
}
