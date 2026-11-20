// Receiving a bot by link: its review, or a copy's original. Making the bot is `bots.create` with
// `fromShare`.
import { BotShareReviewParams } from '../../../../shared/rpc-contract/bots-share-params'
import { defineMethod } from '../core'
import { assertTrustedCaller } from './bots-share'

export const BOT_SHARE_RECEIVE_METHODS = [
  defineMethod({
    name: 'bots.share.review',
    permission: 'workspace',
    params: BotShareReviewParams,
    handler: async ({ shareId, versionId }, context) => {
      assertTrustedCaller(context)
      return { review: await context.runtime.botShares().review(shareId, versionId) }
    }
  })
]
