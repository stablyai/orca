import { useEffect, useSyncExternalStore } from 'react'
import { readHostMethodReply } from '../host-screen/sidebar-feed/host-sidebar-feed-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botAvatarRead, type ListedBot } from './host-bots-operations'

// Pictures no screen draws, kept so a screen drawn again needn't read them over the link; least recently
// drawn go first past this many base64 characters (bytes, as Hermes stores them).
const UNDRAWN_PICTURES_BUDGET = 8 * 1024 * 1024

// The client and listing key that last listed each bot, so a drawn upload reads from that bot's host.
const listedBy = new Map<string, { client: RpcClient; key: string }>()
// A drawn upload whose host has not listed it yet: read once it does.
const waiting = new Map<string, string>()
// Each bot's last picture and the upload versions already asked for; the host answers a bot's current
// picture whichever version asks, so an older version drawn in a room shows it too. Least recently drawn first.
const uploads = new Map<string, { uri: string | null; asked: Set<string> }>()
// How many mounted avatars draw each bot: a drawn picture is never dropped.
const drawn = new Map<string, number>()
const listeners = new Set<() => void>()
let trimQueued = false
let readsInTurn: Promise<void> = Promise.resolve()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notes which host listed these bots under `key`, its whole list; nothing is read until a screen draws one. */
export function noteListedBots(
  client: RpcClient,
  key: string,
  bots: readonly Pick<ListedBot, 'id' | 'avatar'>[]
): void {
  const listed = new Set(bots.map((bot) => bot.id))
  for (const [id, by] of listedBy) {
    // Gone from its host's list: nothing reads it there again.
    if (by.key === key && !listed.has(id)) {
      listedBy.delete(id)
      waiting.delete(id)
    }
  }
  for (const { id, avatar } of bots) {
    listedBy.set(id, { client, key })
    if (avatar && waiting.get(id) === avatar) {
      waiting.delete(id)
      readUpload(id, avatar)
    }
  }
}

/** Lets go of a removed paired host's clients, for its own bots and its servers'. Their pictures stay
 *  while drawn, as another paired host may relay the same server, and go under the budget after. */
export function forgetBotAvatarClients(pairedHostId: string): void {
  for (const [id, { key }] of listedBy) {
    if (key === pairedHostId || key.startsWith(`${pairedHostId}\n`)) {
      listedBy.delete(id)
      waiting.delete(id)
    }
  }
}

// After the commit: a remount runs every cleanup before any mount, and must not drop what it draws again.
function dropUndrawnPastBudgetSoon(): void {
  if (!trimQueued) {
    trimQueued = true
    queueMicrotask(dropUndrawnPastBudget)
  }
}

function dropUndrawnPastBudget(): void {
  trimQueued = false
  let kept = 0
  for (const [id, upload] of uploads) {
    kept += drawn.has(id) ? 0 : (upload.uri?.length ?? 0)
  }
  for (const [id, upload] of uploads) {
    if (kept <= UNDRAWN_PICTURES_BUDGET) {
      return
    }
    if (!drawn.has(id) && upload.uri) {
      // With its versions, so the next draw reads it again.
      kept -= upload.uri.length
      uploads.delete(id)
    }
  }
}

function draw(botId: string): () => void {
  drawn.set(botId, (drawn.get(botId) ?? 0) + 1)
  return () => {
    const count = (drawn.get(botId) ?? 1) - 1
    if (count > 0) {
      drawn.set(botId, count)
      return
    }
    drawn.delete(botId)
    const upload = uploads.get(botId)
    if (upload) {
      // Now the most recently drawn.
      uploads.delete(botId)
      uploads.set(botId, upload)
    }
    dropUndrawnPastBudgetSoon()
  }
}

function readUpload(botId: string, avatar: string): void {
  const upload = uploads.get(botId) ?? { uri: null, asked: new Set<string>() }
  if (upload.asked.has(avatar)) {
    return
  }
  const client = listedBy.get(botId)?.client
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
        if (uploads.get(botId) === upload) {
          waiting.set(botId, avatar)
        }
        return
      }
      upload.uri = read.value.png ? `data:image/png;base64,${read.value.png}` : null
      // Its avatar may have gone while it was read.
      dropUndrawnPastBudgetSoon()
      listeners.forEach((listener) => listener())
    })
}

/** The bot's uploaded picture, read once per upload when first drawn; null until then or when unreadable. */
export function useBotAvatarUpload(botId: string | null, avatar: string | null): string | null {
  const drawing = botId !== null && avatar !== null
  // Apart from the read, so a new upload version never lets go of the picture it replaces.
  useEffect(() => (drawing && botId ? draw(botId) : undefined), [botId, drawing])
  useEffect(() => {
    if (botId && avatar) {
      readUpload(botId, avatar)
    }
  }, [botId, avatar])
  const read = () => (botId && avatar ? (uploads.get(botId)?.uri ?? null) : null)
  return useSyncExternalStore(subscribe, read, read)
}
