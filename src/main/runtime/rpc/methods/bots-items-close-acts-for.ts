// Whom a bot's closing turn acts for, kept on the close so the journal says whose work it was.
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import { turnActsForOwner } from '../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { BotItemWriter } from './bots-items-caller'
import { readBotTurn } from './orchestration/messaging/bot-recipient'

/** Whom the writer's running turn acts for, kept on a close so the journal says whose work it was:
 *  read as every check reads a turn, so a teammate's request taken in the owner's own chat is
 *  theirs, but by index alone from a chat already open, so a close costs the same however long the
 *  chat ran. A turn that read can't place (a chat at rest, a crowded window, a failed read) keeps
 *  the chat's record, as closes did before they read turns; unknown, never the owner, when there is
 *  none. Only who, not where they asked. */
export async function closingTurnActsFor(
  runtime: OrcaRuntimeService,
  writer: Pick<BotItemWriter, 'sessionId'> & { actor: Pick<BotItemWriter['actor'], 'chatId'> }
): Promise<BotRequestAsker[]> {
  return (await closingAskers(runtime, writer)).map((asker): BotRequestAsker =>
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
}

async function closingAskers(
  runtime: OrcaRuntimeService,
  writer: Pick<BotItemWriter, 'sessionId'> & { actor: Pick<BotItemWriter['actor'], 'chatId'> }
): Promise<readonly BotRequestAsker[]> {
  const db = runtime.getOrchestrationDb()
  try {
    const { turn } = await readBotTurn(runtime, db, writer.sessionId, undefined, {
      indexedOnly: true
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
    return chatRecord(runtime, writer.actor.chatId)
  }
}

/** The chat's record, as closes read it before they read turns; unknown when there is none. */
function chatRecord(runtime: OrcaRuntimeService, root: string): readonly BotRequestAsker[] {
  try {
    return runtime.getOrchestrationDb().getBotConversationActsFor(root)?.actsFor ?? UNKNOWN
  } catch (error) {
    console.warn('[bots] could not read whom a closing chat acts for', error)
    return UNKNOWN
  }
}

const UNKNOWN: readonly BotRequestAsker[] = [{ kind: 'unknown' }]
