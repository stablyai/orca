// Whom a bot's closing turn acts for, kept on the close so the journal says whose work it was.
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import { turnActsForOwner } from '../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { BotItemWriter } from './bots-items-caller'
import { readBotTurn } from './orchestration/messaging/bot-recipient'

/** Whom the writer's running turn acts for, kept on a close so the journal says whose work it was:
 *  read as every check reads a turn, so a teammate's request taken in the owner's own chat is
 *  theirs. Unknown, never the owner, when it can't be read. Only who, not where they asked. */
export async function closingTurnActsFor(
  runtime: OrcaRuntimeService,
  writer: Pick<BotItemWriter, 'sessionId'>
): Promise<BotRequestAsker[]> {
  try {
    const { turn } = await readBotTurn(
      runtime,
      runtime.getOrchestrationDb(),
      writer.sessionId,
      undefined,
      { askersOnly: true }
    )
    // A device Orca can't place as the owner typed in it: the owner's chat, but not known to be them.
    const askers: readonly BotRequestAsker[] = turnActsForOwner(turn)
      ? OWNER_ACTS_FOR
      : turn.typedByAnother
        ? [...turn.askers, { kind: 'unknown' }]
        : turn.askers
    return askers.map((asker): BotRequestAsker =>
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
  } catch (error) {
    console.warn('[bots] could not read whom a closing turn acts for', error)
    return [{ kind: 'unknown' }]
  }
}
