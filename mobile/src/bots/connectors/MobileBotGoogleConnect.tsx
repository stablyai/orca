// Connect Google as a page inside the bot's settings: the desktop's Add connector › Google. With the
// host signed in, Google turns on (confirmed when others can ask). With no Google app there, the
// desktop's GoogleHostChoiceDialog: Continue starts the setup in the bot's chat, where its cards carry
// on. With an app but no sign-in, the setup starts at its sign-in card, which the computer finishes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileUp } from 'lucide-react-native'
import {
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../src/shared/google/google-who-can-ask-warning'
import { googleBotConnectState } from '../../../../src/shared/google/google-bot-connect-state'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useMediaPicker } from '../../platform/media-picking/media-picker'
import { googleSetupAnswer } from '../../session/native-chat/transcript/bot-cards/mobile-bot-card-operations'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { decodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import {
  googleBotSet,
  googleClientImport,
  googleSetupStart
} from './bot-connector-account-operations'
import type { PhoneGoogleStatus } from './MobileBotGooglePage'

export function MobileBotGoogleConnect(props: {
  client: RpcClient | null
  bot: PhoneBot
  google: { status: PhoneGoogleStatus | null; refresh: (check?: boolean) => Promise<void> }
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  onClose: () => void
  /** Google is on for the bot: its page takes over. */
  onOn: () => void
  /** The setup carries on in the bot's chat; null while no chat shows. */
  onOpenChat: (() => void) | null
}) {
  const t = useMobileTranslation()
  const { bot, client } = props
  const [busy, setBusy] = useState(false)
  const picker = useMediaPicker()
  useBackClaim(() => {
    props.onClose()
    return true
  })
  const status = props.google.status
  const host = status
    ? googleBotConnectState({
        allowed: bot.google === true,
        client: status.client ?? null,
        accounts: (status.accounts ?? []).map((account) => ({
          status: account.status === 'reconnect' ? 'reconnect' : 'connected'
        }))
      }).host
    : null
  const warning = googleWhoCanAskWarning(bot.name, botOtherAskers(bot))
  const [failed, setFailed] = useState(false)
  const fail = () => {
    setFailed(true)
    props.showToast(t('bots.errors.generic', 'Something went wrong. Try again.'))
  }

  const turnOn = () => {
    if (!client) {
      return
    }
    setBusy(true)
    void googleBotSet
      .request(client, { botId: bot.id, on: true }, { failWhenDisconnected: true })
      .then((reply) => googleBotSet.interpret(reply))
      .then(props.onOn, fail)
      .finally(() => setBusy(false))
  }
  const startInChat = (signIn: boolean) => {
    if (!client) {
      return
    }
    setBusy(true)
    void (async () => {
      googleSetupStart.interpret(
        await googleSetupStart.request(
          client,
          { botId: bot.id, from: 'add-connector' },
          { failWhenDisconnected: true }
        )
      )
      // The app is here: only the owner's sign-in is left, on the setup's own sign-in card.
      if (signIn) {
        googleSetupAnswer.interpret(
          await googleSetupAnswer.request(
            client,
            { botId: bot.id, card: 'path', values: ['import'] },
            { failWhenDisconnected: true }
          )
        )
      }
    })()
      .then(() => {
        if (props.onOpenChat) {
          props.onOpenChat()
        } else {
          props.showToast(
            t('bots.google.continuesInChat', 'Google’s setup continues in {{name}}’s chat.', {
              name: bot.name
            })
          )
          props.onClose()
        }
      }, fail)
      .finally(() => setBusy(false))
  }
  const importFile = () => {
    if (!client) {
      return
    }
    void (async () => {
      for await (const file of picker.pickFiles()) {
        const text = new TextDecoder().decode(decodeBase64Bytes(file.base64))
        googleClientImport.interpret(
          await googleClientImport.request(client, { file: text }, { failWhenDisconnected: true })
        )
        await props.google.refresh()
        return
      }
    })().catch(() =>
      props.showToast(
        t('bots.google.file.notAFile', 'That file isn’t a Google app file. Try another.'),
        2400
      )
    )
  }

  // Signed in, nobody else asks: Google turns on with no question; with an app only, the setup's sign-in.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !props.online) {
      return
    }
    if (host === 'connected' && !warning) {
      started.current = true
      turnOn()
    } else if (host === 'signed-out' || host === 'reconnect') {
      started.current = true
      startInChat(true)
    }
  })

  if (host === 'connected' && warning) {
    return (
      <ConfirmContent
        title={t('bots.google.turnOn.title', 'Turn on Google for {{name}}?', { name: bot.name })}
        message={warning}
        confirmLabel={t('bots.google.turnOn.confirm', 'Turn on')}
        destructive
        onCancel={props.onClose}
        onConfirm={turnOn}
      />
    )
  }
  const cancelHeader = (
    <SheetHeader
      title={t('bots.google.connect', 'Connect Google')}
      leading={{ label: t('bots.google.cancel', 'Cancel'), onPress: props.onClose }}
    />
  )
  if (host !== 'no-app') {
    return (
      <>
        {cancelHeader}
        {props.banner}
        {failed ? (
          <MobileStateView
            title={t('bots.errors.generic', 'Something went wrong. Try again.')}
            action={
              props.online
                ? {
                    label: t('bots.google.retry', 'Try again'),
                    onPress: () => {
                      setFailed(false)
                      started.current = false
                      void props.google.refresh()
                    }
                  }
                : null
            }
          />
        ) : (
          <MobileStateView loading title={t('bots.google.checking', 'Checking Google…')} />
        )}
      </>
    )
  }
  return (
    <>
      <SheetHeader
        title={t('bots.google.connect', 'Connect Google')}
        leading={{ label: t('bots.google.cancel', 'Cancel'), onPress: props.onClose }}
        trailing={{
          label: t('bots.google.hostChoice.continue', 'Continue'),
          disabled: busy || !props.online,
          onPress: () => startInChat(false)
        }}
      />
      {props.banner}
      <SettingsNote>
        {t(
          'bots.google.hostChoice.description',
          'Choose how {{bot}} signs in to your Gmail, Calendar and Drive.',
          { bot: bot.name }
        )}
      </SettingsNote>
      <SettingsSection>
        <ListRow
          title={t('bots.google.hostChoice.self', 'Self hosted')}
          subtitle={t(
            'bots.google.hostChoice.selfNote',
            'You make your own Google Cloud app, so your sign-in stays on your computer. About 10 minutes.'
          )}
          subtitleLines={3}
          selected
          accessibilityRole="radio"
        />
        <ListRow
          title={t('bots.google.hostChoice.orca', 'Orca hosted')}
          subtitle={t('bots.google.hostChoice.orcaNote', 'Sign in with Google. Nothing to set up.')}
          value={t('bots.google.hostChoice.comingSoon', 'Coming soon')}
          disabled
          accessibilityRole="radio"
        />
      </SettingsSection>
      <SettingsSection title={t('bots.google.hostChoice.steps', 'Steps')}>
        {[
          t('bots.google.hostChoice.stepApp', '{{bot}} opens Google Cloud and sets up the app', {
            bot: bot.name
          }),
          t('bots.google.hostChoice.stepSignIn', 'You tick Google’s terms box and sign in'),
          t(
            'bots.google.hostChoice.stepCheck',
            '{{bot}} checks that Gmail, Calendar and Drive work',
            { bot: bot.name }
          )
        ].map((line, index) => (
          <ListRow key={line} marker={String(index + 1)} title={line} wrapTitle />
        ))}
      </SettingsSection>
      <SettingsSection>
        <ListRow
          leading={<FileUp size={18} color={colors.textPrimary} />}
          title={t('bots.google.importFromTeam', 'Import a setup file from your team')}
          navigates
          disabled={!props.online}
          onPress={importFile}
        />
      </SettingsSection>
    </>
  )
}
