// The setup's last two cards on the phone. Sign in opens Google's sign-in in the bot's settings, as
// Reconnect does there, and the card moves on by itself once it's done; then what the bot can use.
import { useEffect, useState } from 'react'
import type { GoogleServiceChoice } from '../../../../../../src/shared/google/google-scopes'
import {
  googleReadyChoices,
  googleSetupBlockerIsConnect,
  googleSetupConnectOpen
} from '../../../../../../src/shared/google/google-setup-card-view'
import { BOTS_GOOGLE_PHONE_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../../../src/shared/bot-runtime-capabilities'
import { useBotPanelOpener } from '../../../../bots/bot-item-open'
import { useRouteCapability } from '../../../../worktree/execution-hosts/use-route-capability'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { googleStatusRead } from './mobile-bot-card-operations'
import { googleServicesList, googleSetupOwnerStep } from './mobile-google-setup-copy'
import {
  MobileGoogleSetupFrame,
  MobileGoogleSetupMuted,
  MobileGoogleSetupOnComputer,
  MobileGoogleSetupReceipt,
  type MobileGoogleSetupScope
} from './MobileGoogleSetupCardParts'
import { MobileGoogleSetupBlockerPanel } from './MobileGoogleSetupProgressCards'

export function MobileGoogleSetupConnectCard({
  scope,
  newest
}: {
  scope: MobileGoogleSetupScope
  newest: boolean
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { run, blocker, fontScale } = scope
  const done = run.steps.connect?.status === 'done'
  const open = googleSetupConnectOpen(run)
  const stuck = blocker && googleSetupBlockerIsConnect(blocker) ? blocker : null
  const opener = useBotPanelOpener(scope.botId)
  // An older host signs Google in only itself, so the card says to finish there.
  const panel = useRouteCapability(BOTS_GOOGLE_PHONE_SIGN_IN_RUNTIME_CAPABILITY) ? opener : null
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.heading', 'Connect Google')}
      trailing={googleSetupOwnerStep(t, 3)}
      title={
        run.account
          ? t('chat.botCards.google.connect.titleAccount', 'Sign in to connect {{email}}', {
              email: run.account
            })
          : t('chat.botCards.google.connect.title', 'Sign in to connect')
      }
      fontScale={fontScale}
    >
      {/* An older copy never acts, done or not; it points down while something is left to press. */}
      {!newest ? (
        stuck || open ? (
          <MobileGoogleSetupMuted
            text={t('chat.botCards.google.movedDown', 'Continued further down.')}
            fontScale={fontScale}
          />
        ) : null
      ) : stuck ? (
        <MobileGoogleSetupBlockerPanel key={stuck.kind} scope={scope} blocker={stuck} />
      ) : done ? (
        <MobileGoogleSetupReceipt
          text={
            run.account
              ? t('chat.botCards.google.receipt.signedInAs', '✓ Signed in as {{email}}', {
                  email: run.account
                })
              : t('chat.botCards.google.receipt.signedIn', '✓ Signed in')
          }
          fontScale={fontScale}
        />
      ) : open && panel ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={t('chat.botCards.google.connect.signIn', 'Sign in to Google')}
            primary
            onPress={() =>
              panel.open({
                settings: {
                  kind: 'google-sign-in',
                  // Setup just made this computer's app, so even a saved account signs in through it.
                  ask: {
                    ...(run.account ? { account: run.account } : {}),
                    services: run.services?.length ? run.services : ['gmail'],
                    currentApp: true
                  },
                  from: { kind: 'list' },
                  next: 'setup',
                  ...(run.kind === 'work' ? {} : { newApp: true })
                }
              })
            }
          />
        </MobileBotCardActions>
      ) : open ? (
        <MobileGoogleSetupOnComputer
          text={t(
            'chat.botCards.google.connect.onComputer',
            'Sign in to Google in Orca on your computer.'
          )}
          fontScale={fontScale}
        />
      ) : null}
    </MobileGoogleSetupFrame>
  )
}

/** What the bot can now use, by the host's reading of the account; the chosen services until it reads. */
export function MobileGoogleSetupConnectedCard({
  scope
}: {
  scope: MobileGoogleSetupScope
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { run, client, fontScale } = scope
  const [ready, setReady] = useState<GoogleServiceChoice[]>(run.services ?? [])
  const account = run.account
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    void googleStatusRead
      .request(client, {})
      .then((response) => {
        const accounts = googleStatusRead.interpret(response).accounts ?? []
        const read = accounts.find((entry) => entry.email === account) ?? accounts[0]
        if (live && read) {
          setReady(googleReadyChoices(read))
        }
      })
      // Unread, it names what was chosen, as the computer's card does.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, account])
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.connected.heading', 'Google connected')}
      {...(account ? { title: account } : {})}
      meta={
        ready.length > 0
          ? t('chat.botCards.google.connected.canUse', '{{bot}} can use {{services}}.', {
              bot: scope.botName,
              services: googleServicesList(t, ready)
            })
          : null
      }
      fontScale={fontScale}
    />
  )
}
