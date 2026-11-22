// The Composio Connect card on the phone: Connect opens the app's sign-in at Composio in the browser while
// the host waits for it, so the card ticks over on return. An app Composio can't sign in to yet shows the
// owner's one-time setup in Composio, then Check again.
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Image } from 'react-native'
import { ExternalLink } from 'lucide-react-native'
import {
  COMPOSIO_PAGES,
  composioAppGuideUrl,
  composioLogoUrl
} from '../../../../../../src/shared/composio/composio-apps'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { requireConnectorLink } from '../../../../bots/connectors/connector-link'
import { openExternalLink } from '../../../../platform/external-links/external-link'
import { colors } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { BOT_CARD_AVATAR_SIZE, MobileBotCardActions } from './MobileBotCardFrame'
import {
  composioAppRead,
  composioCancelConnect,
  composioConnect
} from './mobile-composio-operations'
import { rereadMobileComposio } from './mobile-composio-store'
import {
  composioHeading,
  composioStep,
  MobileComposioLine,
  useComposioCall,
  type MobileComposioScope
} from './MobileComposioCardParts'
import {
  MobileGoogleSetupError,
  MobileGoogleSetupFrame,
  MobileGoogleSetupMuted,
  MobileGoogleSetupNotes
} from './MobileGoogleSetupCardParts'

type SignInCheck = { signIn: string | null; checking: boolean; again: boolean }

/** How the app signs in at Composio now; `check(true)` is the owner's Check again. */
function useAppSignIn(scope: MobileComposioScope, slug: string | undefined, keyReady: boolean) {
  const { client, card } = scope
  const [state, setState] = useState<SignInCheck>({ signIn: null, checking: false, again: false })
  const check = useCallback(
    (again: boolean) => {
      if (!slug) {
        return
      }
      setState((before) => ({ ...before, checking: true }))
      void composioAppRead
        .request(client, { botId: card.botId, app: slug })
        .then((response) => composioAppRead.interpret(response))
        .then(
          (app) => setState({ signIn: app.signIn, checking: false, again }),
          // Unread, the card offers Connect; Composio's answer to it says what's missing.
          () => setState({ signIn: null, checking: false, again })
        )
    },
    [client, card.botId, slug]
  )
  useEffect(() => {
    if (keyReady) {
      check(false)
    }
  }, [keyReady, check])
  return { ...state, check }
}

export function MobileComposioConnectCard({
  scope
}: {
  scope: MobileComposioScope
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const { client, hostKey, card, view, fontScale } = scope
  const { busy, error, setError, run } = useComposioCall()
  const app = card.app
  const signIn = useAppSignIn(scope, app?.slug, view.status?.key === 'ok')
  if (!app) {
    return null
  }
  const connected = view.connections?.connections.some(
    (entry) => entry.app === app.slug && entry.status === 'active'
  )
  const pending = view.connections?.pending.find((entry) => entry.app === app.slug)
  const keyMissing = view.status !== null && view.status.key !== 'ok'
  const needsSetUp = signIn.signIn === 'own' && !connected && !pending && !keyMissing
  const connect = () =>
    void run(async () => {
      const { url } = composioConnect.interpret(
        await composioConnect.request(client, {
          botId: card.botId,
          app: app.slug,
          card: { name: app.name, ...(card.reason ? { reason: card.reason } : {}) }
        })
      )
      rereadMobileComposio(hostKey, card.botId)
      requireConnectorLink(url)
    }).then((ok) => !ok && signIn.check(false))
  const cancel = () =>
    void run(async () => {
      composioCancelConnect.interpret(
        await composioCancelConnect.request(client, { botId: card.botId, app: app.slug })
      )
      rereadMobileComposio(hostKey, card.botId)
    })
  const frame = {
    avatar: <Image source={{ uri: composioLogoUrl(app.slug) }} style={styles.logo} />,
    heading: composioHeading(t),
    trailing: composioStep(t, card),
    fontScale
  }
  if (needsSetUp) {
    return (
      <MobileGoogleSetupFrame
        titleLines={2}
        {...frame}
        title={t(
          'chat.botCards.composio.setUpTitle',
          '{{app}} needs a one-time setup in Composio',
          {
            app: app.name
          }
        )}
      >
        <MobileGoogleSetupNotes
          notes={[
            t(
              'chat.botCards.composio.setUpDeveloperApp',
              'Create a developer app on {{app}}’s developer site. Composio’s {{app}} page shows how.',
              { app: app.name }
            ),
            t(
              'chat.botCards.composio.setUpAuthConfig',
              'In Composio, open Auth Configs, add one for {{app}}, and paste your developer app’s keys.',
              { app: app.name }
            ),
            t('chat.botCards.composio.setUpCheckAgain', 'Come back here and choose Check again.')
          ]}
          fontScale={fontScale}
        />
        {signIn.again && !signIn.checking ? (
          <MobileGoogleSetupMuted
            text={t(
              'chat.botCards.composio.setUpNotYet',
              'Composio has no Auth Config for {{app}} yet.',
              { app: app.name }
            )}
            fontScale={fontScale}
          />
        ) : null}
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={t('chat.botCards.composio.openAuthConfigs', 'Open Auth Configs')}
            Icon={ExternalLink}
            primary
            onPress={() => openExternalLink(COMPOSIO_PAGES.authConfigs)}
          />
          <MobileNativeChatNoticePill
            label={t('chat.botCards.composio.appGuide', '{{app}} page', { app: app.name })}
            Icon={ExternalLink}
            onPress={() => openExternalLink(composioAppGuideUrl(app.slug))}
          />
          <MobileNativeChatNoticePill
            label={t('chat.botCards.composio.checkAgain', 'Check again')}
            disabled={signIn.checking}
            onPress={() => {
              setError(null)
              signIn.check(true)
            }}
          />
        </MobileBotCardActions>
      </MobileGoogleSetupFrame>
    )
  }
  return (
    <MobileGoogleSetupFrame
      titleLines={2}
      {...frame}
      title={t('chat.botCards.composio.connectTitle', 'Connect {{app}}', { app: app.name })}
      meta={
        pending
          ? t(
              'chat.botCards.composio.connecting',
              'Waiting for you to finish signing in, in your browser'
            )
          : signIn.signIn === 'key'
            ? t(
                'chat.botCards.composio.connectKeyNote',
                'Opens Composio to enter your {{app}} API key. Composio keeps it, not Orca.',
                { app: app.name }
              )
            : t(
                'chat.botCards.composio.connectNote',
                'Opens {{app}}’s sign-in from Composio in your browser. Composio keeps this sign-in, not Orca.',
                { app: app.name }
              )
      }
    >
      {connected ? null : pending ? (
        <>
          <MobileComposioLine
            leading={<ActivityIndicator size="small" color={colors.textMuted} />}
            text={t(
              'chat.botCards.composio.signInOnComposio',
              'Sign in to {{app}} on Composio’s page.',
              {
                app: app.name
              }
            )}
            fontScale={fontScale}
          />
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
          <MobileBotCardActions>
            <MobileNativeChatNoticePill
              label={t('chat.botCards.composio.openAgain', 'Open again')}
              Icon={ExternalLink}
              onPress={() => void run(async () => requireConnectorLink(pending.url))}
            />
            <MobileNativeChatNoticePill
              label={t('chat.botCards.composio.cancel', 'Cancel')}
              disabled={busy}
              onPress={cancel}
            />
          </MobileBotCardActions>
        </>
      ) : keyMissing ? (
        <MobileGoogleSetupMuted
          text={t('chat.botCards.composio.keyFirst', 'Add your Composio key first.')}
          fontScale={fontScale}
        />
      ) : (
        <>
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
          <MobileBotCardActions>
            <MobileNativeChatNoticePill
              label={t('chat.botCards.composio.connect', 'Connect {{app}}', { app: app.name })}
              primary
              disabled={busy || view.status === null}
              onPress={connect}
            />
            {error ? (
              <MobileNativeChatNoticePill
                label={t('chat.botCards.composio.openAuthConfigs', 'Open Auth Configs')}
                Icon={ExternalLink}
                onPress={() => openExternalLink(COMPOSIO_PAGES.authConfigs)}
              />
            ) : null}
          </MobileBotCardActions>
        </>
      )}
    </MobileGoogleSetupFrame>
  )
}

const LOGO = BOT_CARD_AVATAR_SIZE - 6

const styles = themedStyleSheet(() => ({
  logo: { width: LOGO, height: LOGO, borderRadius: 4 }
}))
