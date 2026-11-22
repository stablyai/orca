// The live step list, the card for a step the person does, and where the setup is stuck. The work
// itself happens in Google Cloud on the computer; from the phone the owner answers what they can.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type {
  GoogleSetupAction,
  GoogleSetupBlocker
} from '../../../../../../src/shared/google/google-setup-blocker'
import {
  googleSetupActionAnswer,
  googleSetupProgressView,
  googleSetupStepCardView
} from '../../../../../../src/shared/google/google-setup-card-view'
import type { GoogleSetupStep } from '../../../../../../src/shared/google/google-setup-run'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../../platform/clipboard/clipboard'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { colors, pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { googleStatusRead } from './mobile-bot-card-operations'
import { answerMobileGoogleSetup } from './mobile-google-setup-store'
import {
  googleAdminRequest,
  googleSetupActionText,
  googleSetupBlockerText,
  googleSetupStepNotes,
  googleSetupStepTitle
} from './mobile-google-setup-copy'
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

/** Where the setup is stuck and its buttons. One that signs in, imports a key or opens Google Cloud
 *  is on the computer, so the phone names it in one line instead. */
export function MobileGoogleSetupBlockerPanel({
  scope,
  blocker
}: {
  scope: MobileGoogleSetupScope
  blocker: GoogleSetupBlocker
}): React.JSX.Element {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const { busy, error, run } = useMobileGoogleSetupAnswer(scope)
  const [copied, setCopied] = useState(false)
  const { client, hostKey, botId, fontScale } = scope
  // What a button does from the phone: a card answer or the host's Google read; null when it's the
  // computer's (a sign-in, a key file, a Google Cloud page).
  const pressOf = (action: GoogleSetupAction): ((live: RpcClient) => Promise<void>) | null => {
    const answered = googleSetupActionAnswer(action, scope.run)
    if (answered) {
      return (live) => answerMobileGoogleSetup(live, hostKey, botId, answered.card, answered.values)
    }
    if (action.id === 'copy-for-admin') {
      return async (live) => {
        const status = googleStatusRead.interpret(await googleStatusRead.request(live, {}))
        if (status.client) {
          await clipboard.writeText(googleAdminRequest(t, status.client.clientId))
          setCopied(true)
        }
      }
    }
    if (action.id === 'check-again') {
      // Asks Google again; once it answers, the bot hears and runs done again.
      return async (live) => {
        googleStatusRead.interpret(await googleStatusRead.request(live, { check: true }))
        await answerMobileGoogleSetup(live, hostKey, botId, 'step', ['resume'])
      }
    }
    return null
  }
  const pressed = blocker.actions.map((action) => ({ action, press: pressOf(action) }))
  const shown = pressed.filter((entry) => entry.press !== null)
  const elsewhere = pressed.find((entry) => entry.press === null)?.action
  return (
    <View style={styles.panel}>
      <Text style={[styles.panelText, scaledType(typography.bodySize, fontScale)]}>
        {googleSetupBlockerText(t, blocker)}
      </Text>
      <MobileGoogleSetupError text={error} fontScale={fontScale} />
      {copied ? (
        <MobileGoogleSetupMuted
          text={t('chat.botCards.google.copied', 'Copied. Send it to your Google admin.')}
          fontScale={fontScale}
        />
      ) : null}
      {shown.length > 0 ? (
        <MobileBotCardActions>
          {shown.map(({ action, press }, index) => (
            <MobileNativeChatNoticePill
              key={action.id}
              label={googleSetupActionText(t, action)}
              primary={index === 0}
              disabled={busy}
              onPress={() => void run(async () => (client && press ? press(client) : undefined))}
            />
          ))}
        </MobileBotCardActions>
      ) : null}
      {elsewhere ? (
        <MobileGoogleSetupOnComputer
          text={t(
            'chat.botCards.google.action.onComputer',
            'For “{{action}}”, use Orca on your computer.',
            {
              action: googleSetupActionText(t, elsewhere)
            }
          )}
          fontScale={fontScale}
        />
      ) : null}
    </View>
  )
}

function StepMark({ index, status }: { index: number; status: string }): React.JSX.Element {
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
  const t = useMobileTranslation()
  const { run, blocker, fontScale } = scope
  const { busy, error, answer } = useMobileGoogleSetupAnswer(scope)
  const view = googleSetupProgressView(run, blocker, newest)
  // The paused panel offers it already, as one of its buttons.
  const letMe = view.panel?.actions.some((action) => action.id === 'let-me') ? null : view.letMe
  const services = run.services ?? []
  const state =
    view.state === 'done'
      ? t('chat.botCards.google.progress.done', 'Done')
      : view.state === 'waiting'
        ? t('chat.botCards.google.progress.waiting', 'Waiting for you')
        : view.state === 'working'
          ? t('chat.botCards.google.progress.working', 'Working')
          : null
  return (
    <MobileGoogleSetupFrame
      heading={t('chat.botCards.google.progress.heading', 'Setting up Google')}
      trailing={state}
      trailingTone={view.state === 'waiting' ? 'ask' : undefined}
      fontScale={fontScale}
    >
      <View style={styles.steps}>
        {view.steps.map((step, index) => {
          const entry = run.steps[step]
          const status = entry?.status ?? 'pending'
          const who =
            status === 'done'
              ? entry?.by === 'user'
                ? t('chat.botCards.google.progress.you', 'You')
                : scope.botName
              : null
          const note = entry?.note ?? who
          return (
            <View key={step} style={styles.step}>
              <StepMark index={index} status={status} />
              <View style={styles.stepBody}>
                <Text
                  style={[
                    status === 'pending' ? styles.stepPending : styles.stepTitle,
                    scaledType(typography.bodySize, fontScale)
                  ]}
                >
                  {googleSetupStepTitle(t, step, services)}
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
      title={googleSetupStepTitle(t, step, run.services ?? [])}
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
      ) : !view.acts ? (
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

const styles = themedStyleSheet(() => ({
  panel: { gap: spacing.sm },
  panelText: { color: colors.textPrimary },
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
  markTextYou: { color: colors.agentQuestion }
}))
