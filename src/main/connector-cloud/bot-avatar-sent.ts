import type { Bot } from '../../shared/bot-types'
import { botSlackIconLook } from '../../shared/bots/bot-slack-icon'
import { BotSlackIconShownRecords } from '../bots/bot-slack-icon-shown'

type PicturedBot = Pick<Bot, 'avatar' | 'avatarColor' | 'avatarOutfit'>

// Per bot record (records are replaced on write, never changed in place): its look, so a pass over
// unchanged bots derives none again.
const looks = new WeakMap<PicturedBot, string | null>()

export function lookOf(bot: PicturedBot): string | null {
  let look = looks.get(bot)
  if (look === undefined) {
    look = botSlackIconLook(bot)
    looks.set(bot, look)
  }
  return look
}

// What the cloud is sent for a bot: its picture and, for a mascot, its look.
export function pictureKey(bot: PicturedBot): string {
  return `${bot.avatar ?? ''}|${lookOf(bot) ?? ''}`
}

// Per bot, the picture key the cloud last took and the account (its hash) it took it as, so another account
// that signs in gets each picture; read from the connector's memory, never from disk.
export class BotAvatarSent {
  private readonly byBot = new Map<string, { account: string | null; picture: string }>()

  constructor(private readonly knownAccount: () => string | null | undefined) {}

  /** The signed-in account's hash now, or null. */
  account(): string | null {
    return BotSlackIconShownRecords.accountKey(this.knownAccount())
  }

  /** Whether an account other than `account` is signed in now; none signed in is not another. */
  anotherThan(account: string | null): boolean {
    const now = this.account()
    return now !== null && now !== account
  }

  /** Whether the cloud already took `picture` as `account`; signed out (null), any account's counts. */
  took(botId: string, picture: string, account: string | null): boolean {
    const taken = this.byBot.get(botId)
    return taken?.picture === picture && (account === null || taken.account === account)
  }

  set(botId: string, account: string | null, picture: string): void {
    this.byBot.set(botId, { account, picture })
  }

  delete(botId: string): void {
    this.byBot.delete(botId)
  }

  keys(): IterableIterator<string> {
    return this.byBot.keys()
  }
}
