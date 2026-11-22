import { afterAll, beforeAll } from 'vitest'
import { botToolRelay } from './bot-tool-relay'

/** Each bot's run token from the real relay, as Orca hands it to the bot's launches; filled before
 *  the file's tests run and dropped after them. */
export function botRunTokens(botIds: readonly string[]): Readonly<Record<string, string>> {
  const tokens: Record<string, string> = {}
  beforeAll(async () => {
    for (const botId of botIds) {
      tokens[botId] = (await botToolRelay.grant(botId, `/bots/${botId}`)).token
    }
  })
  afterAll(() => botToolRelay.close())
  return tokens
}
