import { parseBotAvatar } from '../../../src/shared/bot-avatar'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botAvatarRead, type ListedBot } from './host-bots-operations'

/** Each uploaded picture as a data URL, read once per upload and kept in `cache`. */
export async function readBotAvatarUploads(
  client: RpcClient,
  bots: readonly Pick<ListedBot, 'id' | 'avatar'>[],
  cache: Map<string, string>
): Promise<ReadonlyMap<string, string>> {
  const uris = new Map<string, string>()
  for (const bot of bots) {
    if (parseBotAvatar(bot.avatar)?.kind !== 'upload' || !bot.avatar) {
      continue
    }
    // The avatar names the upload's bytes, so a cached picture is never stale.
    const cacheKey = `${bot.id}\n${bot.avatar}`
    let uri = cache.get(cacheKey)
    if (!uri) {
      const reply = await botAvatarRead.request(client, { botId: bot.id }).catch(() => null)
      const read = reply && readHostMethodReply(reply, botAvatarRead.interpret)
      const png = read?.kind === 'answered' ? read.value.png : null
      if (png) {
        uri = `data:image/png;base64,${png}`
        cache.set(cacheKey, uri)
      }
    }
    if (uri) {
      uris.set(bot.id, uri)
    }
  }
  return uris
}
