import type { SkillCloudOperation } from '../../../shared/skills/sharing/skill-cloud-contract'
import { botPackageName } from '../../../shared/bots/bot-share-status'

type ShareListing = { listShares(): Promise<SkillCloudOperation<{ id: string; name: string }[]>> }

/** The bot whose saved picks a stop may forget: only one the live listing names as the link's
 *  owner. A failed listing or a link missing from it names no one. */
export async function listedShareOwner(
  client: ShareListing,
  shareId: string,
  botId: string | undefined
): Promise<string | null> {
  if (!botId) {
    return null
  }
  const listed = await client.listShares().catch(() => null)
  const owned =
    listed?.status === 'ok' &&
    listed.value.some((share) => share.id === shareId && share.name === botPackageName(botId))
  return owned ? botId : null
}
