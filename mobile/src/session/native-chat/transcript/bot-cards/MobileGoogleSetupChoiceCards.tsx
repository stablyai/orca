// The setup's choice cards on the phone: how to do it, which Google account, which services. A tap
// records the answer and tells the bot without a chat message; the card folds to a receipt.
import { useState } from 'react'
import { View } from 'react-native'
import {
  GOOGLE_SERVICE_CHOICES,
  type GoogleServiceChoice
} from '../../../../../../src/shared/google/google-scopes'
import {
  googleSetupAnsweredServices,
  googleSetupChoiceChangeable,
  googleSetupChoiceLocked
} from '../../../../../../src/shared/google/google-setup-card-view'
import { GOOGLE_SETUP_MODES } from '../../../../../../src/shared/google/google-setup-run'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatAskOptionRow } from '../../input/prompts/MobileNativeChatAskOptionRow'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import {
  googleChoiceDescription,
  googleChoiceLabel,
  googleServicesList,
  googleSetupOwnerStep,
  googleSetupPathNote,
  googleSetupPathTitle
} from './mobile-google-setup-copy'
import {
  MobileGoogleSetupError,
  MobileGoogleSetupFrame,
  MobileGoogleSetupMuted,
  MobileGoogleSetupReceipt,
  useMobileGoogleSetupAnswer,
  type MobileGoogleSetupScope
} from './MobileGoogleSetupCardParts'

export function MobileGoogleSetupPathCard({
  scope
}: {
  scope: MobileGoogleSetupScope
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { run, fontScale } = scope
  const { busy, error, reopened, reopen, answer } = useMobileGoogleSetupAnswer(scope)
  const answered = run.answers.path?.values[0]
  const chosen = GOOGLE_SETUP_MODES.find((mode) => mode === answered)
  const locked = googleSetupChoiceLocked(run, answered !== undefined, reopened)
  const receipt =
    answered === 'not-now'
      ? t('chat.botCards.google.receipt.dismissed', '✓ Dismissed')
      : answered === 'import'
        ? t('chat.botCards.google.receipt.imported', '✓ You added your team’s file')
        : t('chat.botCards.google.receipt.chose', '✓ You chose {{what}}', {
            what: chosen ? googleSetupPathTitle(t, chosen) : (answered ?? '')
          })
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.heading', 'Connect Google')}
      trailing={googleSetupOwnerStep(t, 1)}
      title={t('chat.botCards.google.path.title', 'How should we set it up?')}
      meta={
        locked
          ? null
          : t(
              'chat.botCards.google.path.why',
              'You create your own Google app, so your sign-in stays on your computer.'
            )
      }
      fontScale={fontScale}
    >
      {locked ? (
        answered !== undefined ? (
          <MobileGoogleSetupReceipt
            text={receipt}
            fontScale={fontScale}
            {...(googleSetupChoiceChangeable(run) ? { onChange: reopen } : {})}
          />
        ) : null
      ) : (
        <>
          <View>
            {GOOGLE_SETUP_MODES.map((mode) => (
              <MobileNativeChatAskOptionRow
                key={mode}
                label={googleSetupPathTitle(t, mode)}
                description={googleSetupPathNote(t, mode, scope.botName)}
                selected={false}
                disabled={busy}
                onPress={() => void answer('path', [mode])}
              />
            ))}
          </View>
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
          <MobileBotCardActions>
            <MobileNativeChatNoticePill
              label={t('chat.botCards.google.notNow', 'Not now')}
              disabled={busy}
              onPress={() => void answer('path', ['not-now'])}
            />
          </MobileBotCardActions>
        </>
      )}
    </MobileGoogleSetupFrame>
  )
}

export function MobileGoogleSetupAccountCard({
  scope
}: {
  scope: MobileGoogleSetupScope
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { run, fontScale } = scope
  const { busy, error, reopened, reopen, answer } = useMobileGoogleSetupAnswer(scope)
  const answered = run.answers.account?.values[0]
  const locked = googleSetupChoiceLocked(run, answered !== undefined, reopened)
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.progress.heading', 'Setting up Google')}
      title={t('chat.botCards.google.account.title', 'Which Google account should I use?')}
      fontScale={fontScale}
    >
      {locked ? (
        answered !== undefined ? (
          <MobileGoogleSetupReceipt
            text={t('chat.botCards.google.receipt.chose', '✓ You chose {{what}}', {
              what: answered
            })}
            fontScale={fontScale}
            {...(googleSetupChoiceChangeable(run) ? { onChange: reopen } : {})}
          />
        ) : null
      ) : (
        <>
          <View>
            {(run.accounts ?? []).map((email) => (
              <MobileNativeChatAskOptionRow
                key={email}
                label={email}
                description={
                  /@(gmail|googlemail)\.com$/i.test(email)
                    ? t('chat.botCards.google.account.personal', 'Personal account')
                    : t('chat.botCards.google.account.work', 'Work account')
                }
                selected={false}
                disabled={busy}
                onPress={() => void answer('account', [email])}
              />
            ))}
          </View>
          <MobileGoogleSetupMuted
            text={t(
              'chat.botCards.google.account.note',
              'Every Google Cloud page opens as the account you pick.'
            )}
            fontScale={fontScale}
          />
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
        </>
      )}
    </MobileGoogleSetupFrame>
  )
}

export function MobileGoogleSetupServicesCard({
  scope
}: {
  scope: MobileGoogleSetupScope
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { run, fontScale } = scope
  const { busy, error, reopened, reopen, answer } = useMobileGoogleSetupAnswer(scope)
  const answered = googleSetupAnsweredServices(run)
  const locked = googleSetupChoiceLocked(run, answered !== null, reopened)
  const [picked, setPicked] = useState<GoogleServiceChoice[]>(answered ?? ['gmail'])
  const toggle = (choice: GoogleServiceChoice) =>
    setPicked((current) =>
      current.includes(choice)
        ? current.filter((entry) => entry !== choice)
        : GOOGLE_SERVICE_CHOICES.filter((entry) => entry === choice || current.includes(entry))
    )
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.heading', 'Connect Google')}
      trailing={googleSetupOwnerStep(t, 2)}
      title={t('chat.botCards.google.services.title', 'Which Google services should I use?')}
      fontScale={fontScale}
    >
      {locked ? (
        answered ? (
          <MobileGoogleSetupReceipt
            text={t('chat.botCards.google.receipt.chose', '✓ You chose {{what}}', {
              what: googleServicesList(t, answered)
            })}
            fontScale={fontScale}
            {...(googleSetupChoiceChangeable(run)
              ? {
                  onChange: () => {
                    // From the latest answer, which another device may have changed.
                    setPicked(answered)
                    reopen()
                  }
                }
              : {})}
          />
        ) : null
      ) : (
        <>
          <View>
            {GOOGLE_SERVICE_CHOICES.map((choice) => (
              <MobileNativeChatAskOptionRow
                key={choice}
                label={googleChoiceLabel(t, choice)}
                description={googleChoiceDescription(t, choice)}
                multi
                selected={picked.includes(choice)}
                disabled={busy}
                onPress={() => toggle(choice)}
              />
            ))}
          </View>
          <MobileGoogleSetupMuted
            text={t(
              'chat.botCards.google.services.note',
              'With any of these, I can find people by name. You can add more later.'
            )}
            fontScale={fontScale}
          />
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
          <MobileBotCardActions>
            <MobileNativeChatNoticePill
              label={t('chat.botCards.google.continue', 'Continue')}
              primary
              disabled={picked.length === 0 || busy}
              onPress={() => void answer('services', picked)}
            />
          </MobileBotCardActions>
        </>
      )}
    </MobileGoogleSetupFrame>
  )
}
