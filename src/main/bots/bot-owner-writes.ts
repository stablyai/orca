// What Orca adds to a write a bot makes as its owner (orca linear): the redirect away from the place that
// woke the run, and who asked when that wasn't the owner. Read from Orca's own record of the turn.
import type { Bot } from '../../shared/bot-types'
import { turnActsForOwner, type BotActingTurn, type BotWakingPlace } from './bot-request-asker'

export const WAKING_PLACE_REFUSAL =
  'That\'s where you were woken: answer there with `orca bot reply --text "..."` (your final message is posted there too). Labels, assignees and status there are fine with orca linear.'

/** The bot's turn, as a write it makes as its owner needs it; null outside a bot's chat. */
export type BotWriteTurn = { bot: Pick<Bot, 'name'>; turn: BotActingTurn; inConversation: boolean }

/** The Linear issue key that woke the run, when the run answers there. */
export function wakingLinearIssue(write: BotWriteTurn | null): string | null {
  const woken: BotWakingPlace | null = write?.inConversation ? write.turn.wokenAt : null
  return woken?.source === 'linear' ? woken.placeId : null
}

export function isSameLinearIssue(key: string, identifier: string | undefined): boolean {
  return identifier !== undefined && key.trim().toUpperCase() === identifier.trim().toUpperCase()
}

/** "asked by Carol via Scout" when someone other than the owner asked; null for the owner. */
export function askedByLine(write: BotWriteTurn | null): string | null {
  if (!write || turnActsForOwner(write.turn)) {
    return null
  }
  const names = [
    ...new Set(
      write.turn.askers.flatMap((asker) =>
        asker.kind === 'person' && asker.role !== 'owner' ? [asker.name ?? asker.userId] : []
      )
    )
  ]
  return names.length > 0 ? clippedAskedBy(names, write.bot.name) : null
}

/** The longest "asked by" line, so it always fits beside the text it ends (Docs comments cap at 2,048). */
export const ASKED_BY_MAX_CHARS = 140

/** Names drop into "and N others" until the line fits; a long first name is cut, keeping the bot. */
function clippedAskedBy(names: string[], botName: string): string {
  const line = (shown: string[], others: number) =>
    `asked by ${shown.join(', ')}${others > 0 ? ` and ${others} other${others === 1 ? '' : 's'}` : ''} via ${botName}`
  for (let shown = names.length; shown >= 1; shown--) {
    const candidate = line(names.slice(0, shown), names.length - shown)
    if (candidate.length <= ASKED_BY_MAX_CHARS) {
      return candidate
    }
  }
  const room = ASKED_BY_MAX_CHARS - line([''], names.length - 1).length - 1
  return line([`${(names[0] ?? '').slice(0, Math.max(0, room))}…`], names.length - 1).slice(
    0,
    ASKED_BY_MAX_CHARS
  )
}

/** A comment body ending with who asked, when that wasn't the owner and the bot didn't write it. */
export function withAskedBy(body: string, write: BotWriteTurn | null): string {
  const line = askedByLine(write)
  return line && !body.toLowerCase().includes(line.toLowerCase())
    ? `${body.trimEnd()}\n\n${line}`
    : body
}
