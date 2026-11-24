import { useContext, useMemo, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { MobileFooterRowsScrollerContext } from './transcript/agent-messages/use-mobile-footer-row-on-screen'
import { createMobileNativeChatTailViewport } from './transcript/viewport/mobile-native-chat-tail-viewport'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './transcript/viewport/mobile-native-chat-disclosure-store'
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  RotateCcw,
  X
} from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import {
  nativeChatFirstScreen,
  nativeChatFirstScreenSignIn,
  nativeChatKickoffEnded,
  nativeChatKickoffRefusal,
  type NativeChatFirstScreen
} from '../../../../src/shared/bots/bot-first-screen'
import { botSetupSteps, type BotSetupStepState } from '../../../../src/shared/bots/bot-setup-steps'
import { firstLookRows, type FirstLookRow } from '../../../../src/shared/bots/bot-first-look'
import { firstLookRowText } from '../../../../src/shared/bots/bot-first-look-words'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session/view/agent-session-attention-capabilities'
import { MobileBotAvatar } from '../../bots/MobileBotAvatar'
import { botKickoffRetry } from '../../bots/bot-sheet-operations'
import { useHostBotById } from '../../bots/host-bot-store'
import { botAgentLabel } from '../../bots/mobile-bot-sheet-copy'
import { LoadingSpinner } from '../../components/feedback/LoadingSpinner'
import { DisclosureChevron } from '../../components/list/DisclosureChevron'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { triggerError } from '../../platform/haptics/haptics'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { useMobileStructuredSessionHostExecutionPhase } from './agent-session/use-mobile-structured-session-host-execution'
import { MobileNativeChatBotIdentityContext } from './mobile-native-chat-bot-identity'
import { useMobileBotCardHost } from './transcript/bot-cards/mobile-bot-card-host'
import { MobileNativeChatNoticePill } from './transcript/notices/MobileNativeChatNoticePill'
import { MobileNativeChatNoticeContext } from './transcript/notices/mobile-native-chat-notice-context'
import { MobileNativeChatUsageLimitStatus } from './transcript/notices/MobileNativeChatUsageLimitStatus'
import { agentSessionSignInCommand } from '../../../../src/shared/agent-session/lifecycle/launch/agent-session-setup-commands'

/** A new bot's Home Chat while Orca's kickoff turn runs, or after it failed without a word; null
 *  otherwise. Only from a confirmed read of a host that reports its turns (`turnJournal` null until
 *  then), so a stored copy or an older host never hides the chat. */
export function useMobileBotFirstScreen(
  messages: readonly NativeChatMessage[],
  turnJournal: NativeChatTurnJournal | null,
  isWorking: boolean
): NativeChatFirstScreen | null {
  const botId = useContext(MobileNativeChatBotIdentityContext)?.botId
  return useMemo(() => {
    if (!botId || turnJournal?.latestTurn === undefined) {
      return null
    }
    const session = {
      isWorking,
      latestTurn: turnJournal.latestTurn,
      submissions: turnJournal.submissions
    }
    return nativeChatFirstScreen(
      messages,
      nativeChatKickoffEnded(session),
      nativeChatKickoffRefusal(session)
    )
  }, [botId, messages, turnJournal, isWorking])
}

function StepMark({ state }: { state: BotSetupStepState }): React.JSX.Element {
  switch (state) {
    case 'running':
      return <LoadingSpinner size={17} color={colors.textMuted} />
    case 'done':
      return <CircleCheck size={17} color={colors.textMuted} strokeWidth={2} />
    case 'failed':
      return <CircleX size={17} color={colors.statusRed} strokeWidth={2} />
    case 'pending':
      return <Circle size={17} color={colors.textMuted} strokeWidth={2} />
  }
}

function LookMark({ state }: { state: FirstLookRow['state'] }): React.JSX.Element {
  switch (state) {
    case 'done':
      return <Check size={15} color={colors.textMuted} strokeWidth={2.2} />
    case 'running':
      return <LoadingSpinner size={15} color={colors.textMuted} />
    case 'stopped':
      return <X size={15} color={colors.textMuted} strokeWidth={2.2} />
  }
}

/** The desktop's first screen: who the bot is, its setup step by step, Try again once a step failed,
 *  and what it finds as it first looks around. */
export function MobileBotFirstScreen({
  firstScreen,
  after
}: {
  firstScreen: NativeChatFirstScreen
  /** Drawn below the setup, such as other agents' waiting mail. */
  after?: React.ReactNode
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const identity = useContext(MobileNativeChatBotIdentityContext)
  const bot = useHostBotById(identity?.botId ?? '')
  const client = useMobileBotCardHost()?.client ?? null
  const notices = useContext(MobileNativeChatNoticeContext)
  const statusFeed = useRouteCapability(AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY)
  const agentReady =
    useMobileStructuredSessionHostExecutionPhase({
      client,
      sessionId: identity?.sessionId ?? null,
      enabled: statusFeed
    }) === 'ready'
  const failed = firstScreen.phase === 'failed'
  const rows = useMemo(() => firstLookRows(firstScreen.turn, failed), [firstScreen.turn, failed])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  if (!identity?.botId || !bot) {
    return <SetupMail after={after} />
  }
  const { botId } = identity
  const agent = botAgentLabel(bot.agent)
  const { start, reply } = botSetupSteps({
    turn: firstScreen.turn,
    ended: failed,
    agentReady,
    refused: firstScreen.refused
  })
  const steps = [
    {
      id: 'create',
      step: { state: 'done' as const },
      label: t('bots.firstScreen.stepCreate', 'Create bot')
    },
    {
      id: 'start',
      step: start,
      label: t('bots.firstScreen.startAgent', 'Start {{agent}}', { agent })
    },
    { id: 'reply', step: reply, label: t('bots.firstScreen.stepReply', 'First message') }
  ]
  const providerDetail = start.providerDetail ?? reply.providerDetail
  const stepFailed = start.state === 'failed' || reply.state === 'failed'
  // A sign-in the failure owes, as the transcript's own failure row offers it: in a host terminal.
  const owed = nativeChatFirstScreenSignIn(firstScreen)
  // Its usage limit keeps the transcript row's own recovery: the reset, Switch account, Continue.
  const failureBlock = firstScreen.turn
    .flatMap((message) => message.blocks)
    .findLast((block) => block.type === 'text' && block.failure !== undefined)
  const runInTerminal = notices.onRunInTerminal
  const signInCommand =
    owed && runInTerminal
      ? agentSessionSignInCommand(notices.agentName, { account: owed.account, remote: true })
      : null
  const tryAgain = () => {
    if (!client) {
      return
    }
    setAsking(true)
    setRetryError(null)
    void botKickoffRetry
      .request(client, { botId })
      .then((outcome) => botKickoffRetry.interpret(outcome))
      .catch(() => {
        triggerError()
        setRetryError(t('bots.firstScreen.retryFailed', 'Could not try again. Try in a moment.'))
      })
      .finally(() => setAsking(false))
  }
  const reading = rows.some((row) => row.state === 'running')
  return (
    <>
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.who}>
          <MobileBotAvatar avatar={identity.avatar} size={80} />
          <Text style={styles.name}>{bot.name}</Text>
          <Text style={styles.subtitle}>
            {t('bots.firstScreen.subtitle', 'Your new bot · runs your {{agent}}', { agent })}
          </Text>
        </View>
        <SectionHeader title={t('bots.firstScreen.setup', 'Setup')} />
        <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
          {steps.map(({ id, step, label }) => (
            <ListRow
              key={id}
              title={label}
              {...(step.detail ? { subtitle: step.detail, subtitleLines: 3 } : {})}
              leading={<StepMark state={step.state} />}
              destructive={step.state === 'failed'}
              disabled={step.state === 'pending'}
            />
          ))}
          {providerDetail ? (
            <ListRow
              title={t('common.details', 'Details')}
              leading={
                <DisclosureChevron expanded={detailsOpen} collapsedDeg={0} expandedDeg={90}>
                  <ChevronRight size={15} color={colors.textMuted} strokeWidth={2.2} />
                </DisclosureChevron>
              }
              detail={
                detailsOpen ? (
                  <Text selectable style={styles.providerDetail}>
                    {providerDetail}
                  </Text>
                ) : undefined
              }
              accessibilityRole="button"
              onPress={() => setDetailsOpen(!detailsOpen)}
            />
          ) : null}
          {stepFailed ? (
            <ListRow
              title={t('bots.firstScreen.failed', 'Couldn’t finish setting up')}
              wrapTitle
              {...(retryError ? { subtitle: retryError } : {})}
              detail={
                failureBlock?.type === 'text' ? (
                  <MobileNativeChatUsageLimitStatus notice={failureBlock} fontScale={1} />
                ) : undefined
              }
              accessory={
                <View style={styles.actions}>
                  {signInCommand && runInTerminal ? (
                    <MobileNativeChatNoticePill
                      label={t('chat.notice.signIn', 'Sign in')}
                      accessibilityHint={t(
                        'chat.notice.signInHint',
                        'Opens a terminal on the computer running this chat'
                      )}
                      primary
                      onPress={() => runInTerminal(signInCommand)}
                    />
                  ) : null}
                  <MobileNativeChatNoticePill
                    label={t('bots.firstScreen.tryAgain', 'Try again')}
                    Icon={RotateCcw}
                    disabled={asking || !client}
                    onPress={tryAgain}
                  />
                </View>
              }
            />
          ) : null}
        </ListGroup>
        {rows.length > 0 ? (
          <>
            <SectionHeader
              title={
                reading || !failed
                  ? t('bots.firstScreen.reading', 'Getting to know your setup…')
                  : t('bots.firstScreen.read', 'Getting to know your setup')
              }
            />
            <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
              {rows.map((row) => (
                <ListRow
                  key={row.area}
                  title={firstLookRowText(row, t)}
                  leading={<LookMark state={row.state} />}
                />
              ))}
            </ListGroup>
          </>
        ) : null}
      </ScrollView>
      <SetupMail after={after} />
    </>
  )
}

/** Other agents' waiting mail under setup: outside the chat's list, so at most half the screen and
 *  scrolling on its own; its rows read their place from this scroller, not the list. */
function SetupMail({ after }: { after: React.ReactNode }): React.JSX.Element | null {
  return after ? <SetupMailScroller after={after} /> : null
}

/** Mounts with its scroller, so a scroller that empties and comes back starts its place afresh. */
function SetupMailScroller({ after }: { after: React.ReactNode }): React.JSX.Element {
  const [viewport] = useState(() => createMobileNativeChatTailViewport(true))
  // Its own open-state store: rows scrolled away drop their card and keep it.
  const disclosures = useMobileNativeChatDisclosures('bot-setup-mail')
  return (
    <MobileFooterRowsScrollerContext.Provider value={viewport}>
      <ScrollView
        style={styles.mail}
        onScroll={(event) => viewport.record(event.nativeEvent)}
        scrollEventThrottle={32}
        onContentSizeChange={(_width, height) => viewport.contentResized(height)}
        onLayout={(event) => viewport.laidOut(event.nativeEvent.layout.height)}
      >
        <MobileNativeChatDisclosureContext.Provider value={disclosures}>
          {after}
        </MobileNativeChatDisclosureContext.Provider>
      </ScrollView>
    </MobileFooterRowsScrollerContext.Provider>
  )
}

const styles = themedStyleSheet(() => ({
  root: { flex: 1 },
  mail: { flexGrow: 0, maxHeight: '50%' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  // On the chat's own background, not a sheet's, so a step above it in both themes.
  group: { backgroundColor: colors.bgRaised },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  who: { alignItems: 'center', paddingTop: spacing.xl, gap: spacing.xs },
  name: {
    marginTop: spacing.sm,
    fontSize: 20,
    fontWeight: '600',
    color: colors.textPrimary
  },
  subtitle: { fontSize: typography.bodySize, color: colors.textMuted, textAlign: 'center' },
  providerDetail: {
    marginTop: spacing.xs,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    color: colors.textSecondary
  }
}))
