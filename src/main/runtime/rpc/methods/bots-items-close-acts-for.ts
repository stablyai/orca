// Whom a bot's closing turn acts for, kept on the close so the journal says whose work it was.
import {
  distinctAskers,
  OWNER_ACTS_FOR,
  type BotRequestAsker
} from '../../../../shared/bots/bot-acts-for'
import { turnActsForOwner } from '../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { BotItemWriter } from './bots-items-caller'
import { readBotTurn } from './orchestration/messaging/bot-recipient'
import { readFirstMessageActsFor } from './orchestration/messaging/bot-first-message-acts-for'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Whom the writer's running turn acts for, kept on a close so the journal says whose work it was:
 *  read as every check reads a turn, so a teammate's request taken in the owner's own chat is
 *  theirs, but by index alone from a chat already open, so a close costs the same however long the
 *  chat ran. A turn that read can't place (a chat at rest, a crowded window, a failed read) keeps
 *  whom the chat acts for, as closes did before they read turns. Only who, not where they asked. */
export async function closingTurnActsFor(
  runtime: OrcaRuntimeService,
  writer: Pick<BotItemWriter, 'sessionId'> & { actor: Pick<BotItemWriter['actor'], 'chatId'> }
): Promise<BotRequestAsker[]> {
  const askers = await closingAskers(runtime, writer)
  return askers ? whoOnly(askers) : closingChatActsFor(runtime, writer)
}

/** Whom the writer's chat acts for, as closes read it before they read turns: its record, else its
 *  /clear root's first message when that conversation is already open (never opening one). For a
 *  write that most likely closes nothing, so it reads no turn. */
export async function closingChatActsFor(
  runtime: OrcaRuntimeService,
  writer: { actor: Pick<BotItemWriter['actor'], 'chatId'> }
): Promise<BotRequestAsker[]> {
  const root = writer.actor.chatId
  try {
    const db = runtime.getOrchestrationDb()
    const recorded = db.getBotConversationActsFor(root)?.actsFor
    const host = getStructuredAgentSessionHost()
    // Started in the same tick as the check, so it takes the open handle and can't reopen one.
    const reads = !recorded && host?.hasSession(root) ? host.journalReads(root) : null
    const askers = recorded ?? (reads ? await readFirstMessageActsFor(db, reads, null) : null)
    return whoOnly(askers ?? UNKNOWN)
  } catch (error) {
    console.warn('[bots] could not read whom a closing chat acts for', error)
    return whoOnly(UNKNOWN)
  }
}

function whoOnly(askers: readonly BotRequestAsker[]): BotRequestAsker[] {
  // Without where they asked, the same person stamped in two workspaces is one.
  return distinctAskers(
    askers.map((asker): BotRequestAsker =>
      asker.kind === 'person'
        ? {
            kind: 'person',
            source: asker.source,
            userId: asker.userId,
            ...(asker.name ? { name: asker.name } : {}),
            workspaceId: null,
            role: asker.role
          }
        : asker
    )
  )
}

async function closingAskers(
  runtime: OrcaRuntimeService,
  writer: Pick<BotItemWriter, 'sessionId'> & { actor: Pick<BotItemWriter['actor'], 'chatId'> }
): Promise<readonly BotRequestAsker[] | null> {
  const db = runtime.getOrchestrationDb()
  try {
    const { turn } = await readBotTurn(runtime, db, writer.sessionId, undefined, {
      indexedOnly: true,
      root: writer.actor.chatId
    })
    // A device Orca can't place as the owner typed in it: the owner's chat, but not known to be them.
    return turnActsForOwner(turn)
      ? OWNER_ACTS_FOR
      : turn.typedByAnother
        ? [...turn.askers, { kind: 'unknown' }]
        : turn.askers
  } catch (error) {
    // A chat at rest, or a turn only the whole chat could place, is not read: an expected answer.
    if (!(error instanceof Error && error.name === 'JournalWindowNotIndexed')) {
      console.warn('[bots] could not read whom a closing turn acts for', error)
    }
    return null
  }
}

const UNKNOWN: readonly BotRequestAsker[] = [{ kind: 'unknown' }]
