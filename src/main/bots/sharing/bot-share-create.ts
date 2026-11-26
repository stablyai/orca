// Create from a shared link: the reviewed content, kept in main under the review's id, or nothing. The
// link must still serve the reviewed version. The bot is made the normal way first, so its record is the
// handle any failure after it deletes it by; then its home gets the reviewed files and paused schedules.
import { mascotAvatar } from '../../../shared/bot-avatar'
import type { Bot } from '../../../shared/bot-types'
import type { BotPackagePlan, BotPackageV1 } from '../../../shared/bots/bot-package'
import type { BotCreateParams } from '../../../shared/rpc-contract/bots-params'
import type { BotController } from '../bot-controller'
import {
  applyBotPackage,
  type BotPackageApplyDeps,
  type BotPackageSetup
} from '../bot-package-apply'
import { recipientFiles, recipientPlan } from './bot-share-receive'
import type { BotRecipientContent } from './bot-share-recipient'

export type BotShareCreateParams = BotCreateParams & {
  fromShare: NonNullable<BotCreateParams['fromShare']>
}

export type BotShareCreateDeps = BotPackageApplyDeps & {
  bots: Pick<BotController, 'create' | 'delete' | 'setAvatarImage'>
  /** The reviewed content, once the link is checked to still serve it; throws the receive errors. */
  reviewed: (reviewId: string) => Promise<BotRecipientContent>
}

/** What the sharer's bot used that this owner sets up themselves. The note is the sharer's own words. */
function sharedSetup(sharedBy: string | null, plan: BotPackagePlan): BotPackageSetup {
  return {
    sharedBy,
    connectors: plan.connectors,
    toolsToSignIn: plan.tools.map((tool) => tool.name),
    schedulesOff: plan.schedules.map((schedule) => schedule.name),
    eventsSuggested: plan.eventSuggestions.map(({ name, source, event }) => ({
      name,
      source,
      event
    })),
    ...(plan.setupNote ? { sharerNote: plan.setupNote } : {})
  }
}

/** The shared mascot's tile color and outfit, for a client from before shared looks, which sends the mascot
 *  alone; a newer one sends the look it shows (`lookSent`). */
export function lookForOlderClient(
  params: Pick<BotCreateParams, 'avatar'>,
  fromShare: Pick<BotShareCreateParams['fromShare'], 'lookSent'>,
  shared: Pick<BotPackageV1, 'avatar'>
): Pick<BotCreateParams, 'avatarColor' | 'avatarOutfit'> {
  const avatar = shared.avatar && 'mascot' in shared.avatar ? shared.avatar : null
  if (fromShare.lookSent || !avatar || params.avatar !== mascotAvatar(avatar.mascot)) {
    return {}
  }
  return {
    ...(avatar.color ? { avatarColor: avatar.color } : {}),
    ...(avatar.outfit ? { avatarOutfit: avatar.outfit } : {})
  }
}

export async function createBotFromShare(
  deps: BotShareCreateDeps,
  input: BotShareCreateParams
): Promise<Bot> {
  const { fromShare, ...params } = input
  const recipient = await deps.reviewed(fromShare.reviewId)
  const agent = params.agent ?? 'claude'
  const plan = recipientPlan(recipient, { agent, toolIds: fromShare.toolIds })
  const { source } = recipient
  const bot = await deps.bots.create(
    { ...lookForOlderClient(params, fromShare, recipient.bot), ...params, agent },
    {
      sharedFrom: {
        shareId: source.shareId,
        packageId: source.packageId,
        versionId: source.versionId,
        sharedBy: source.publisher,
        sharedAt: source.publishedAt
      }
    }
  )
  return applyBotPackage(
    deps,
    bot,
    {
      files: recipientFiles(recipient, plan),
      tools: plan.tools,
      schedules: plan.schedules,
      setup: sharedSetup(source.publisher, plan)
    },
    // A picture the owner picked in New bot replaces the shared one.
    async (made) =>
      !params.avatar && recipient.avatarBase64
        ? await deps.bots.setAvatarImage(made.id, Buffer.from(recipient.avatarBase64, 'base64'))
        : made
  )
}
