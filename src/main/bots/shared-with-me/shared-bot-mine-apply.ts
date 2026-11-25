// The cloud's list of shares, applied to what this computer keeps. A share offered to this account
// waits for its Accept: until then nothing of it is kept here (no entry, no device keys), so nothing
// pairs. A share this account declined is kept as declined and never offered again.
import { botShareUsable } from '../../../shared/bots/bot-team-shares'
import type { SharedBotRequestView } from '../../../shared/bots/shared-bot-hosts'
import type { SharedBotHeldSends } from './shared-bot-held-sends'
import {
  newSharedBotHostEntry,
  sharedBotHostKey,
  type SharedBotHostEntry,
  type SharedBotHostStore
} from './shared-bot-host-store'
import { pinnedSharedBotOffer, type MineShare } from './shared-bot-pairing'

/** Whether this account hasn't declined the share here (`botShareUsable`, as the owner's host asks). */
export function usableHere(store: SharedBotHostStore, shareId: string): boolean {
  return botShareUsable(store.answer(shareId))
}

/** Whether this computer keeps (and pairs) a listed share: never once declined; else accepted here
 *  before, or by this account on another of its devices (the cloud says one reaches it). */
function kept(store: SharedBotHostStore, share: MineShare): boolean {
  return (
    usableHere(store, share.shareId) &&
    (store.get(share.shareId) !== undefined || share.state === 'ready')
  )
}

/** The shares that wait for this account's Accept or Decline. */
export function sharedBotRequests(
  store: SharedBotHostStore,
  shares: ReadonlyMap<string, MineShare> | null
): SharedBotRequestView[] {
  return [...(shares?.values() ?? [])]
    .filter((share) => !kept(store, share) && usableHere(store, share.shareId))
    .map(({ shareId, botId, botName, ownerName, botPurpose, avatarUrl }) => ({
      shareId,
      botId,
      botName,
      ownerName,
      ...(botPurpose ? { botPurpose } : {}),
      ...(avatarUrl ? { avatarUrl } : {})
    }))
}

/** Applies the list; returns the kept shares it no longer lists, now removed. */
export function applySharedBotMine(
  deps: {
    store: SharedBotHostStore
    held: Pick<SharedBotHeldSends, 'applyMine' | 'settle'>
    closeLink: (shareId: string) => void
  },
  shares: readonly MineShare[],
  read: number
): SharedBotHostEntry[] {
  const { store, held } = deps
  held.applyMine(shares)
  const listed = new Set(shares.map((share) => share.shareId))
  const gone = store.list().filter((entry) => !listed.has(entry.shareId))
  gone.forEach((entry) => deps.closeLink(entry.shareId))
  store.remove(new Set(gone.map((entry) => entry.shareId)))
  for (const share of shares.filter((candidate) => kept(store, candidate))) {
    const entry = store.get(share.shareId) ?? newSharedBotHostEntry(share)
    const { hostKey: _hostKey, avatarUrl: _avatar, ...rest } = entry
    const offer = pinnedSharedBotOffer(entry, share)
    const hostKey = sharedBotHostKey({ offer, hostKey: share.hostKey })
    store.put({
      ...rest,
      botName: share.botName,
      ownerName: share.ownerName,
      ...(share.avatarUrl ? { avatarUrl: share.avatarUrl } : {}),
      ...(hostKey ? { hostKey } : {}),
      ...(offer ? { offer } : {}),
      held: held.settle(entry.held, read)
    })
  }
  return gone
}
