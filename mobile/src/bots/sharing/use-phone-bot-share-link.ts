// The bot's one live link as the phone reads it from the computer's Orca account; the desktop's
// useBotShareLink.
import { useCallback, useEffect, useState } from 'react'
import { botShareStatusOf, type BotOwnedShare } from '../../../../src/shared/bots/bot-share-status'
import { translate } from '../../i18n/mobile-i18n'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botShareErrorMessage } from './bot-share-copy'
import { botShareErrorCode, isBotShareSignIn, listPhoneBotShares } from './bot-share-operations'

export type PhoneShareLink = {
  shareId: string
  url: string
  versionId: string
  /** When the link last changed; null when unknown. */
  updatedAt: string | null
  /** The digest of what it serves; null when unread, so the bot reads as changed. */
  digest: string | null
}

export type PhoneShareLinkRead =
  | { kind: 'loading' }
  | { kind: 'read'; link: PhoneShareLink | null }
  | { kind: 'offline'; error: string | null }
  | { kind: 'signIn' }

export function phoneShareLinkOfShare(share: BotOwnedShare): PhoneShareLink {
  return {
    shareId: share.id,
    url: share.url,
    versionId: share.pinnedVersionId ?? '',
    updatedAt: share.pinnedPublishedAt ?? share.createdAt,
    digest: share.pinnedDigest ?? null
  }
}

function linkOf(shares: readonly BotOwnedShare[], botId: string): PhoneShareLink | null {
  const status = botShareStatusOf(shares, botId)
  return status.shared
    ? {
        shareId: status.shareId,
        url: status.url,
        versionId: status.versionId,
        updatedAt: status.updatedAt,
        digest: status.digest
      }
    : null
}

export type PhoneShareLinkState = {
  read: PhoneShareLinkRead
  setLink: (link: PhoneShareLink | null) => void
  reread: () => void
}

/** The bot's live link; with `shareId`, that one link of the bot's (an older build's, from Shared links). */
export function usePhoneBotShareLink(
  client: RpcClient | null,
  botId: string,
  shareId?: string
): PhoneShareLinkState {
  const [read, setRead] = useState<PhoneShareLinkRead>({ kind: 'loading' })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    listPhoneBotShares(client, botId).then(
      (shares) => {
        if (!live) {
          return
        }
        if (!shareId) {
          setRead({ kind: 'read', link: linkOf(shares, botId) })
          return
        }
        const selected = shares.find((share) => share.id === shareId)
        setRead(
          selected
            ? { kind: 'read', link: phoneShareLinkOfShare(selected) }
            : {
                kind: 'offline',
                error: translate(
                  'bots.share.linkNoLongerAvailable',
                  'This share link is no longer available.'
                )
              }
        )
      },
      (cause: unknown) => {
        if (!live) {
          return
        }
        setRead(
          isBotShareSignIn(cause)
            ? { kind: 'signIn' }
            : {
                kind: 'offline',
                error: botShareErrorCode(cause) ? botShareErrorMessage(cause) : null
              }
        )
      }
    )
    return () => {
      live = false
    }
  }, [client, botId, shareId, version])
  return {
    read,
    setLink: useCallback((link) => setRead({ kind: 'read', link }), []),
    reread: useCallback(() => {
      setRead({ kind: 'loading' })
      setVersion((current) => current + 1)
    }, [])
  }
}
