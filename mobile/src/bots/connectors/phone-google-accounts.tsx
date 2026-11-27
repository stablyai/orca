// The host's Google accounts on the phone: their status, and what the desktop's GoogleAccountRow and
// AccountList do with them (Set as default, Share setup, and Disconnect's confirm).
import { useCallback, useEffect } from 'react'
import { joinSentences } from '../../../../src/shared/text/sentence-joining'
import { Share } from 'react-native'
import { googleAppExportFileName } from '../../../../src/shared/google/google-console-setup'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  googleClientExport,
  googleDefaultSet,
  googleDisconnect
} from './bot-connector-account-operations'
import { hostReadClient } from '../../query/host-read-client'
import {
  connectorReadCells,
  connectorReadKey,
  setConnectorRead,
  useConnectorRead,
  type ConnectorReadCell
} from './phone-connector-reads'
import { googleStatusRead } from '../../session/native-chat/transcript/bot-cards/mobile-bot-card-operations'

export type PhoneGoogleStatus = ReturnType<typeof googleStatusRead.interpret>

/** `status` is null until read; `unread` when a read failed with nothing shown yet. */
export type PhoneGoogle = {
  status: PhoneGoogleStatus | null
  unread: boolean
  /** When the shown read was sent (0: never); another surface's may be minutes old. */
  readAt: number
  refresh: (check?: boolean) => Promise<void>
}

type GoogleCell = ConnectorReadCell<Pick<PhoneGoogle, 'status' | 'unread' | 'readAt'>>

const googleCells = connectorReadCells((): GoogleCell => ({
  value: { status: null, unread: false, readAt: 0 }
}))

/** The host's Google app and accounts, one answer for every surface; `check` asks Google again first. */
export function usePhoneGoogleStatus(
  client: RpcClient | null,
  hostKey: string,
  enabled: boolean,
  again: number
): PhoneGoogle {
  const cell = googleCells(connectorReadKey(hostKey, 'google'))
  const { status, unread, readAt } = useConnectorRead(cell)
  const refresh = useCallback(
    async (check = false) => {
      if (!client) {
        return
      }
      // Only an answer newer than the shown one lands, whichever surface asked.
      const sentAt = Date.now()
      const read = await googleStatusRead
        .request(hostReadClient(client), check ? { check: true } : {})
        .then((reply) => googleStatusRead.interpret(reply))
        // Unread, the page keeps what it showed.
        .catch(() => null)
      if (read && sentAt >= cell.value.readAt) {
        setConnectorRead(cell, { status: read, unread: false, readAt: sentAt })
      } else if (!read) {
        setConnectorRead(cell, { ...cell.value, unread: true })
      }
    },
    [client, cell]
  )
  useEffect(() => {
    if (enabled) {
      void refresh()
    }
  }, [enabled, refresh, again])
  return { status, unread, readAt, refresh }
}

/** `say`: a toast, or with no message the generic failure. */
export function useGoogleAccountCalls(
  client: RpcClient | null,
  google: PhoneGoogle,
  say: (message?: string) => void
): { makeDefault: (account: string) => void; shareSetup: () => void } {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const makeDefault = (account: string) => {
    if (client) {
      void googleDefaultSet
        .request(client, { account }, { failWhenDisconnected: true })
        .then((reply) => googleDefaultSet.interpret(reply))
        .then(
          () => google.refresh(),
          () => say()
        )
    }
  }
  // The team's app file through the share sheet; where there is none (Android's web view), copied.
  const shareSetup = () => {
    if (!client) {
      return
    }
    const name = googleAppExportFileName(google.status?.client?.projectId)
    void googleClientExport
      .request(client, {}, { failWhenDisconnected: true })
      .then((reply) => googleClientExport.interpret(reply))
      .then(({ file }) =>
        Share.share({ title: name, message: file }).catch(async (error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') {
            return
          }
          await clipboard.writeText(file)
          say(t('bots.google.share.copied', 'Copied. Send it to your teammates.'))
        })
      )
      .catch(() => say())
  }
  return { makeDefault, shareSetup }
}

export function GoogleDisconnectConfirm(props: {
  client: RpcClient | null
  google: PhoneGoogle
  email: string
  /** Google also cancels Orca's access. */
  revoke: boolean
  onClose: () => void
  /** Disconnect was confirmed, not cancelled. */
  onConfirmed?: () => void
  failed: () => void
}) {
  const t = useMobileTranslation()
  const { email, revoke, google } = props
  const accounts = google.status?.accounts ?? []
  const defaultAccount = google.status?.defaultAccount
  const nextDefault = accounts.find((account) => account.email !== defaultAccount)?.email
  const promoted =
    email === defaultAccount && nextDefault
      ? t('bots.google.disconnect.promotes', '{{email}} becomes the default.', {
          email: nextDefault
        })
      : ''
  return (
    <ConfirmContent
      title={t('bots.google.disconnect.title', 'Disconnect {{email}}?', { email })}
      message={joinSentences(
        [
          revoke
            ? t(
                'bots.google.disconnect.revokeNote',
                'Bots stop using this account here, and Google cancels Orca’s access everywhere it was allowed.'
              )
            : accounts.length > 1
              ? t('bots.google.disconnect.removeOneNote', 'Bots stop using this account here.')
              : t(
                  'bots.google.disconnect.removeNote',
                  'Bots stop using this account here. Bot settings stay, so Connect Google turns it back on.'
                ),
          promoted
        ].filter(Boolean)
      )}
      confirmLabel={t('bots.google.disconnect.confirm', 'Disconnect')}
      destructive
      onCancel={props.onClose}
      onConfirm={() => {
        props.onClose()
        props.onConfirmed?.()
        if (props.client) {
          void googleDisconnect
            .request(props.client, { account: email, revoke }, { failWhenDisconnected: true })
            .then((reply) => googleDisconnect.interpret(reply))
            .then(() => google.refresh(), props.failed)
        }
      }}
    />
  )
}
