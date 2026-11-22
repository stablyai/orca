// Adding a Composio app from Connectors, all on the phone: the desktop's Add connector Composio steps (the
// key, once for every bot on the host, then the app's sign-in at Composio in the phone's browser while the
// host waits). Composio's pages are ordinary https pages.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Image, Text, View } from 'react-native'
import { ArrowUpRight, ExternalLink } from 'lucide-react-native'
import { COMPOSIO_PAGES, composioLogoUrl } from '../../../../src/shared/composio/composio-apps'
import { errorMessage } from '../../../../src/shared/errors/error-message'
import { TextField } from '../../components/composer-input/TextField'
import { MobileStateButton, MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardReader } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import {
  composioAdd,
  composioAppRead,
  composioConnect,
  composioSetKey
} from '../../session/native-chat/transcript/bot-cards/mobile-composio-operations'
import {
  rereadMobileComposio,
  type MobileComposio
} from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotTextButton } from '../MobileBotTextButton'

export type ComposioScope = {
  client: RpcClient | null
  hostKey: string
  botId: string
  composio: MobileComposio
  hostName: string
  online: boolean
  banner: ReactNode
}

const LOGO = 28

export function AppLogo({ slug, size = LOGO }: { slug: string; size?: number }) {
  return <Image source={{ uri: composioLogoUrl(slug) }} style={{ width: size, height: size }} />
}

/** Adds one Composio app to the bot: the key first if the host has none, then its sign-in. */
export function MobileBotComposioConnect(
  props: ComposioScope & {
    app: { slug: string; name: string }
    onClose: () => void
    /** Signed in (or nothing to sign in to): Connectors takes over. */
    onDone: () => void
  }
) {
  const t = useMobileTranslation()
  const { client, app, composio } = props
  const clipboard = useClipboardReader()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [own, setOwn] = useState(false)
  // The sign-in page opened, and the host's sign-ins as they read then.
  const [opened, setOpened] = useState<{
    url: string
    read: MobileComposio['connections']
  } | null>(null)
  // Connectors takes over once; the sign-in shows as connected on every read after.
  const done = useRef(false)
  useBackClaim(() => {
    props.onClose()
    return true
  })
  const keyReady = composio.status?.key === 'ok'
  const pending = composio.connections?.pending.find((entry) => entry.app === app.slug)
  const connected = composio.connections?.connections.some(
    (entry) => entry.app === app.slug && entry.status === 'active'
  )
  /** Asks Composio how the app signs in, then adds it, or opens its sign-in in the phone's browser. */
  const connect = async () => {
    if (!client) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { signIn } = composioAppRead.interpret(
        await composioAppRead.request(client, { botId: props.botId, app: app.slug })
      )
      setOwn(signIn === 'own')
      if (signIn === 'own') {
        return
      }
      if (signIn === 'none') {
        composioAdd.interpret(await composioAdd.request(client, { botId: props.botId }))
        rereadMobileComposio(props.hostKey, props.botId)
        done.current = true
        props.onDone()
        return
      }
      const { url } = composioConnect.interpret(
        await composioConnect.request(client, { botId: props.botId, app: app.slug })
      )
      setOpened({ url, read: composio.connections })
      rereadMobileComposio(props.hostKey, props.botId)
      openExternalLink(url)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  const saveKey = async (value: string) => {
    if (!client) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      composioSetKey.interpret(
        await composioSetKey.request(client, { key: value }, { failWhenDisconnected: true })
      )
      setKey('')
      rereadMobileComposio(props.hostKey, props.botId)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  // With the key in, the app's sign-in opens at once, as the desktop's dialog moves on.
  const asked = useRef(false)
  useEffect(() => {
    if (keyReady && !asked.current && !pending && !connected) {
      asked.current = true
      void connect()
    }
  })
  useEffect(() => {
    if (connected && !done.current) {
      done.current = true
      props.onDone()
    }
  })

  if (composio.status === null) {
    return <MobileStateView loading title={t('bots.composio.reading', 'Reading Composio…')} />
  }
  if (!keyReady) {
    const trimmed = key.trim()
    const save = () => void saveKey(trimmed)
    return (
      <>
        <SheetHeader
          title={t('bots.apps.composio.connectTitle', 'Connect Composio')}
          subtitle={t('bots.apps.composio.once', 'Once, for all your bots')}
          onBack={{ label: t('bots.connectors.backShort', 'Back'), onPress: props.onClose }}
        />
        {props.banner}
        <SettingsNote>
          {t('bots.apps.composio.thenApp', 'Then you sign in to {{app}} on Composio’s page.', {
            app: app.name
          })}
        </SettingsNote>
        <View style={styles.field}>
          <TextField
            label={t('bots.composio.key.label', 'Composio API key')}
            placeholder={t('bots.composio.key.placeholder', 'Paste your key')}
            value={key}
            onChangeText={setKey}
            secureTextEntry
            monospace
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            trailing={
              <MobileBotTextButton
                label={t('bots.slack.token.paste', 'Paste')}
                onPress={() =>
                  void clipboard
                    .readText()
                    .then((text) => setKey(text.trim()))
                    .catch(() => {})
                }
              />
            }
          />
        </View>
        {error ? <SettingsNote error>{error}</SettingsNote> : null}
        <SettingsNote>
          {t(
            'bots.apps.composio.keyStoredOnHost',
            'Stored on {{host}}; bots never see it. Composio holds your app sign-ins.',
            { host: props.hostName }
          )}
        </SettingsNote>
        <SettingsSection>
          <ListRow
            leading={<ArrowUpRight size={18} color={colors.textPrimary} />}
            title={t('bots.composio.key.getKey', 'Get a key')}
            accessibilityRole="link"
            onPress={() => openExternalLink(COMPOSIO_PAGES.apiKeys)}
          />
        </SettingsSection>
        <View style={styles.field}>
          <SheetPrimaryButton
            label={
              busy
                ? t('bots.composio.key.checking', 'Checking…')
                : t('bots.apps.composio.addKey', 'Add key and continue')
            }
            busy={busy}
            disabled={!trimmed || !props.online}
            onPress={save}
          />
        </View>
      </>
    )
  }
  const header = (
    <SheetHeader
      title={app.name}
      leading={{ label: t('bots.apps.close', 'Close'), onPress: props.onClose }}
    />
  )
  if (own) {
    return (
      <>
        {header}
        {props.banner}
        <MobileStateView
          iconElement={<AppLogo slug={app.slug} />}
          title={t(
            'chat.botCards.composio.setUpTitle',
            '{{app}} needs a one-time setup in Composio',
            { app: app.name }
          )}
          message={t(
            'chat.botCards.composio.setUpAuthConfig',
            'In Composio, open Auth Configs, add one for {{app}}, and paste your developer app’s keys.',
            { app: app.name }
          )}
        >
          <SheetPrimaryButton
            label={t('chat.botCards.composio.openAuthConfigs', 'Open Auth Configs')}
            icon={ExternalLink}
            onPress={() => openExternalLink(COMPOSIO_PAGES.authConfigs)}
          />
          <MobileStateButton
            label={t('chat.botCards.composio.checkAgain', 'Check again')}
            disabled={busy}
            onPress={() => void connect()}
          />
        </MobileStateView>
      </>
    )
  }
  const page = pending?.url ?? opened?.url
  // The host stops waiting when Composio turns it down, fails or runs out of time: a read after the
  // page opened with no wait and no sign-in.
  const ended =
    opened !== null && composio.connections !== opened.read && !pending && !connected && !busy
  const failure =
    error ??
    (ended
      ? t('bots.composio.signInEnded', 'The sign-in was turned down, failed, or took too long.')
      : null)
  const again = () => {
    setOpened(null)
    void connect()
  }
  return (
    <>
      {header}
      {props.banner}
      <MobileStateView
        iconElement={<AppLogo slug={app.slug} />}
        title={
          failure
            ? t('bots.apps.couldNotSignIn', 'Couldn’t sign in to {{app}}', { app: app.name })
            : t('bots.apps.signingIn', 'Signing in')
        }
        message={
          failure ??
          t('bots.composio.signInOnComposio', 'Sign in to {{app}} on Composio’s page.', {
            app: app.name
          })
        }
      >
        {failure ? (
          <SheetPrimaryButton
            label={t('bots.composio.tryAgain', 'Try again')}
            disabled={busy || !props.online}
            onPress={again}
          />
        ) : (
          <>
            <View style={styles.waiting}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.waitingText}>
                {t(
                  'chat.botCards.composio.connecting',
                  'Waiting for you to finish signing in, in your browser'
                )}
              </Text>
            </View>
            {page ? (
              <MobileStateButton
                label={t('bots.apps.openPageAgain', 'Open page again')}
                onPress={() => openExternalLink(page)}
              />
            ) : null}
          </>
        )}
      </MobileStateView>
      {failure ? null : (
        <SettingsNote>
          {t(
            'bots.apps.closeKeepsSigningIn',
            'Sign-in continues in your browser if you close this.'
          )}
        </SettingsNote>
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  field: { marginTop: spacing.lg },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  waitingText: { flexShrink: 1, color: colors.textSecondary, fontSize: 13 }
}))
