// The setup's last two cards on the phone. Google's sign-in returns to the computer, so the phone
// says where to finish and the card moves on by itself once it's done; then what the bot can use.
import { useEffect, useState } from 'react'
import type { GoogleServiceChoice } from '../../../../../../src/shared/google/google-scopes'
import {
  googleReadyChoices,
  googleSetupBlockerIsConnect
} from '../../../../../../src/shared/google/google-setup-card-view'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
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
  const stuck = blocker && googleSetupBlockerIsConnect(blocker) ? blocker : null
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
        stuck || !done ? (
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
      ) : (
        <MobileGoogleSetupOnComputer
          text={t(
            'chat.botCards.google.connect.onComputer',
            'Sign in to Google in Orca on your computer.'
          )}
          fontScale={fontScale}
        />
      )}
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
