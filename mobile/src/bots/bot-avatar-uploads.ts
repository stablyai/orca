import { useEffect, useSyncExternalStore } from 'react'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botAvatarRead, type ListedBot } from './host-bots-operations'

// The client that last listed each bot, so a drawn upload reads from that bot's host.
const listedBy = new Map<string, RpcClient>()
// A drawn upload whose host has not listed it yet: read once it does.
const waiting = new Map<string, string>()
// Each bot's last picture and the upload versions already asked for; the host answers a bot's current
// picture whichever version asks, so an older version drawn in a room shows it too.
const uploads = new Map<string, { uri: string | null; asked: Set<string> }>()
const listeners = new Set<() => void>()
let readsInTurn: Promise<void> = Promise.resolve()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notes which host listed these bots; nothing is read until a screen draws one. */
export function noteListedBots(
  client: RpcClient,
  bots: readonly Pick<ListedBot, 'id' | 'avatar'>[]
): void {
  for (const { id, avatar } of bots) {
    listedBy.set(id, client)
    if (avatar && waiting.get(id) === avatar) {
      waiting.delete(id)
      readUpload(id, avatar)
    }
  }
}

function readUpload(botId: string, avatar: string): void {
  const upload = uploads.get(botId) ?? { uri: null, asked: new Set<string>() }
  if (upload.asked.has(avatar)) {
    return
  }
  const client = listedBy.get(botId)
  if (!client) {
    waiting.set(botId, avatar)
    return
  }
  upload.asked.add(avatar)
  uploads.set(botId, upload)
  // One read at a time: a long list must not pull every multi-MB picture over the link at once.
  readsInTurn = readsInTurn
    .then(() => botAvatarRead.request(client, { botId }))
    .then((reply) => readHostMethodReply(reply, botAvatarRead.interpret))
    .catch(() => null)
    .then((read) => {
      if (read?.kind !== 'answered') {
        // Asked again once the host lists the bot again.
        upload.asked.delete(avatar)
        waiting.set(botId, avatar)
        return
      }
      upload.uri = read.value.png ? `data:image/png;base64,${read.value.png}` : null
      listeners.forEach((listener) => listener())
    })
}

/** The bot's uploaded picture, read once per upload when first drawn; null until then or when unreadable. */
export function useBotAvatarUpload(botId: string | null, avatar: string | null): string | null {
  useEffect(() => {
    if (botId && avatar) {
      readUpload(botId, avatar)
    }
  }, [botId, avatar])
  const read = () => (botId && avatar ? (uploads.get(botId)?.uri ?? null) : null)
  return useSyncExternalStore(subscribe, read, read)
}
