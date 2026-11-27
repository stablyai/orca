// The live step list, the card for a step the person does, and where the setup is stuck. The work
// itself happens in Google Cloud on the computer; from the phone the owner answers what they can.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  googleSetupFoldedSteps,
  googleSetupProgressView,
  googleSetupShownStepStatus,
  googleSetupStepCardView
} from '../../../../../../src/shared/google/google-setup-card-view'
import type { GoogleSetupStep } from '../../../../../../src/shared/google/google-setup-run'
import { intlLocaleFor } from '../../../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../../../i18n/use-mobile-translation'
import { pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { googleSetupStepNotes, googleSetupStepTitle } from './mobile-google-setup-copy'
import {
  MobileGoogleSetupError,
  MobileGoogleSetupFrame,
  MobileGoogleSetupMuted,
  MobileGoogleSetupNotes,
  MobileGoogleSetupOnComputer,
  MobileGoogleSetupReceipt,
  useMobileGoogleSetupAnswer,
  type MobileGoogleSetupScope
} from './MobileGoogleSetupCardParts'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { MobileGoogleSetupBlockerPanel } from './MobileGoogleSetupBlockerPanel'

function StepMark({ index, status }: { index: number; status: string }): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View
      style={[
        styles.mark,
        status === 'active' && styles.markActive,
        status === 'needs-user' && styles.markYou,
        status === 'done' && styles.markDone
      ]}
    >
      {status === 'done' ? (
        <Check size={11} color={colors.bgPanel} strokeWidth={3} />
      ) : (
        <Text
          style={[
            styles.markText,
            status === 'active' && styles.markTextActive,
            status === 'needs-user' && styles.markTextYou
          ]}
        >
          {index + 1}
        </Text>
      )}
    </View>
  )
}

export function MobileGoogleSetupProgressCard({
  scope,
  newest
}: {
  scope: MobileGoogleSetupScope
  newest: boolean
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const locale = intlLocaleFor(useMobileUiLocale())
  const { run, blocker, fontScale } = scope
  const { busy, error, answer } = useMobileGoogleSetupAnswer(scope)
  const view = googleSetupProgressView(run, blocker, newest)
  // The paused panel offers it already, as one of its buttons.
  const letMe = view.panel?.actions.some((action) => action.id === 'let-me') ? null : view.letMe
  const services = run.services ?? []
  const [expanded, setExpanded] = useState(false)
  const { before, after } = expanded
    ? { before: 0, after: 0 }
    : googleSetupFoldedSteps(run, view.steps)
  // Either folded line opens the whole list.
  const fold = (mark: React.ReactNode, label: string) => (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      onPress={() => setExpanded(true)}
      style={({ pressed }) => [styles.step, pressed && pressedStyle]}
    >
      {mark}
      <Text style={[styles.stepPending, scaledType(typography.bodySize, fontScale)]}>{label}</Text>
    </Pressable>
  )
  const state =
    view.state === 'done'
      ? t('chat.botCards.google.progress.done', 'Done')
      : view.state === 'waiting'
        ? t('chat.botCards.google.progress.waiting', 'Waiting for you')
        : view.state === 'working'
          ? t('chat.botCards.google.progress.working', 'Working')
          : view.state === 'stopped'
            ? t('chat.botCards.google.progress.stopped', 'Stopped')
            : null
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.progress.heading', 'Setting up Google')}
      trailing={state}
      trailingTone={view.state === 'waiting' ? 'ask' : undefined}
      fontScale={fontScale}
    >
      <View style={styles.steps}>
        {before > 0
          ? fold(
              <StepMark index={0} status="done" />,
              t('chat.botCards.google.progress.doneCount', '{{count}} steps done', {
                count: before
              })
            )
          : null}
        {view.steps.slice(before, view.steps.length - after).map((step, offset) => {
          const entry = run.steps[step]
          const status = googleSetupShownStepStatus(run, step)
          // A stopped run's open step drops what it asked of the person.
          const note = status === (entry?.status ?? 'pending') ? entry?.note : null
          return (
            <View key={step} style={styles.step}>
              <StepMark index={before + offset} status={status} />
              <View style={styles.stepBody}>
                <Text
                  style={[
                    status === 'pending' ? styles.stepPending : styles.stepTitle,
                    scaledType(typography.bodySize, fontScale)
                  ]}
                >
                  {googleSetupStepTitle(t, locale, step, services)}
                </Text>
                {note ? (
                  <Text
                    style={[
                      status === 'needs-user' ? styles.stepNoteYou : styles.stepNote,
                      scaledType(typography.metaSize, fontScale)
                    ]}
                  >
                    {note}
                  </Text>
                ) : null}
                {step === 'account' && view.switchAccount ? (
                  <StepLink
                    label={t('chat.botCards.google.otherAccount', 'Switch account')}
                    disabled={busy}
                    onPress={() => void answer('account', ['other'])}
                    fontScale={fontScale}
                  />
                ) : null}
              </View>
            </View>
          )
        })}
        {after > 0
          ? fold(
              <View style={styles.foldMark} />,
              t('chat.botCards.google.progress.more', '+ {{count}} more steps', { count: after })
            )
          : null}
      </View>
      <MobileGoogleSetupError text={error} fontScale={fontScale} />
      {view.panel ? (
        <MobileGoogleSetupBlockerPanel key={view.panel.kind} scope={scope} blocker={view.panel} />
      ) : null}
      {letMe ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={t('chat.botCards.google.letMe', 'Let me do this one')}
            disabled={busy}
            onPress={() => void answer('step', ['let-me', letMe])}
          />
        </MobileBotCardActions>
      ) : null}
      {view.state === 'stopped' && newest ? (
        <MobileGoogleSetupReceipt
          text={t('chat.botCards.google.receipt.stopped', 'Setup stopped')}
          fontScale={fontScale}
        />
      ) : null}
    </MobileGoogleSetupFrame>
  )
}

function StepLink({
  label,
  disabled,
  onPress,
  fontScale
}: {
  label: string
  disabled: boolean
  onPress: () => void
  fontScale: number
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => [styles.stepLink, pressed && pressedStyle]}
    >
      <Text style={[styles.stepLinkText, scaledType(typography.metaSize, fontScale)]}>{label}</Text>
    </Pressable>
  )
}

export function MobileGoogleSetupStepCard({
  scope,
  step,
  newest
}: {
  scope: MobileGoogleSetupScope
  step: GoogleSetupStep
  newest: boolean
}): React.JSX.Element {
  const t = useMobileTranslation()
  const locale = intlLocaleFor(useMobileUiLocale())
  const { run, fontScale } = scope
  const { busy, error, answer } = useMobileGoogleSetupAnswer(scope)
  const view = googleSetupStepCardView(run, step, newest)
  const lead = run.steps[step]?.note
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.step.headingCount', 'Your turn · {{n}} of {{total}}', {
        n: view.n,
        total: view.total
      })}
      trailing={
        view.watching && !busy ? t('chat.botCards.google.step.watching', 'Watching the page') : null
      }
      title={googleSetupStepTitle(t, locale, step, run.services ?? [])}
      meta={view.acts ? lead : null}
      fontScale={fontScale}
    >
      {view.done ? (
        <MobileGoogleSetupReceipt
          text={t('chat.botCards.google.receipt.done', '✓ Done')}
          fontScale={fontScale}
        />
      ) : view.handedBack ? (
        <MobileGoogleSetupReceipt
          text={t('chat.botCards.google.receipt.takeOver', '✓ {{bot}} takes over from here', {
            bot: scope.botName
          })}
          fontScale={fontScale}
        />
      ) : view.ended ? null : !view.acts ? (
        <MobileGoogleSetupMuted
          text={t('chat.botCards.google.movedDown', 'Continued further down.')}
          fontScale={fontScale}
        />
      ) : (
        <>
          <MobileGoogleSetupNotes
            notes={googleSetupStepNotes(t, step, run.kind)}
            fontScale={fontScale}
          />
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
          <MobileBotCardActions>
            <MobileNativeChatNoticePill
              label={t('chat.botCards.google.done', 'Done')}
              primary
              disabled={busy}
              onPress={() => void answer('step', ['done', step])}
            />
            {view.takeOver ? (
              <MobileNativeChatNoticePill
                label={t('chat.botCards.google.takeOver', 'Take over from here')}
                disabled={busy}
                onPress={() => void answer('step', ['take-over', step])}
              />
            ) : null}
          </MobileBotCardActions>
          <MobileGoogleSetupOnComputer
            text={t(
              'chat.botCards.google.step.onComputer',
              'Do this in Google Cloud on your computer.'
            )}
            fontScale={fontScale}
          />
        </>
      )}
    </MobileGoogleSetupFrame>
  )
}

const MARK = 20

const stylesSheet = themedStyleSheet((colors) => ({
  steps: { gap: spacing.sm },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stepBody: { flex: 1, minWidth: 0, gap: 1 },
  stepTitle: { color: colors.textPrimary },
  stepPending: { color: colors.textMuted },
  stepNote: { color: colors.textMuted },
  stepNoteYou: { color: colors.agentQuestion },
  stepLink: { alignSelf: 'flex-start', paddingTop: 2 },
  stepLinkText: { color: colors.textPrimary, fontWeight: '600' },
  mark: {
    width: MARK,
    height: MARK,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  markActive: { borderColor: colors.textPrimary },
  markYou: { borderColor: colors.agentQuestion },
  markDone: { backgroundColor: colors.textSecondary, borderColor: colors.textSecondary },
  markText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  markTextActive: { color: colors.textPrimary },
  markTextYou: { color: colors.agentQuestion },
  foldMark: { width: MARK }
}))
