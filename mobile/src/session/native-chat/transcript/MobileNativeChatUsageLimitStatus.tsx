import { useCallback, useContext, useSyncExternalStore } from 'react'
import { Text, View } from 'react-native'
import { ArrowLeftRight, Play } from 'lucide-react-native'
import { readWholeAgentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import type { NativeChatTextBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import { colors, feedback, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { MobileNativeChatNoticePill } from './MobileNativeChatNoticePill'
import { scaledType } from './mobile-native-chat-message-styles'
import { nativeChatUsageLimitStatusText } from './native-chat-usage-limit-copy'
import { MobileNativeChatNoticeContext } from './mobile-native-chat-notice-context'

/** True from the reset on; re-renders once when it passes. */
function useResetPassed(resetsAt: number | undefined): boolean {
  const subscribe = useCallback(
    (passed: () => void) => {
      const wait = resetsAt === undefined ? 0 : resetsAt - Date.now()
      if (wait <= 0) {
        return () => {}
      }
      const timer = setTimeout(passed, Math.min(wait, 2_147_483_647))
      return () => clearTimeout(timer)
    },
    [resetsAt]
  )
  const read = () => resetsAt !== undefined && Date.now() >= resetsAt
  return useSyncExternalStore(subscribe, read, read)
}

/** Under a usage-limit headline: the reset and Orca's plan on one line, then the actions. */
export function MobileNativeChatUsageLimitStatus({
  notice,
  fontScale
}: {
  notice: NativeChatTextBlock
  fontScale: number
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { usageLimit, openAccounts } = useContext(MobileNativeChatNoticeContext)
  const failure = readWholeAgentSessionFailureFact(notice.failure)
  const resetsAt = failure?.kind === 'usageLimitReached' ? failure.usageLimit?.resetsAt : undefined
  const resetPassed = useResetPassed(resetsAt)
  const actions =
    failure?.kind === 'usageLimitReached' &&
    notice.usageLimitTurnItemId !== undefined &&
    usageLimit?.turnItemId === notice.usageLimitTurnItemId
      ? usageLimit
      : null
  // The line names the reset Orca waits for; Continue still keys off the cut's own reset.
  const shownAt = actions?.autoContinue ? (actions.continueAt ?? resetsAt) : resetsAt
  const shownPassed = useResetPassed(shownAt)
  if (failure?.kind !== 'usageLimitReached') {
    return null
  }
  // Draw the row's actions once, with the host's answer for this cut, rather than adding them late.
  if (actions && actions.canSwitchAccount === undefined) {
    return null
  }
  const status = nativeChatUsageLimitStatusText(
    { resetsAt: shownAt, resetPassed: shownPassed, autoContinue: actions?.autoContinue ?? null },
    t
  )
  const switchAccount = actions?.canSwitchAccount ? (openAccounts ?? null) : null
  const continueNow = actions && resetPassed ? actions.continueNow : null
  if (!status && !switchAccount && !continueNow) {
    return null
  }
  const meta = [styles.meta, scaledType(typography.metaSize, fontScale)]
  return (
    <View style={styles.block}>
      {status ? (
        <Text selectable={INLINE_TEXT_SELECTION} style={meta}>
          {status}
          {actions?.cancel ? (
            <>
              {' · '}
              <Text
                accessibilityRole="button"
                accessibilityState={{ disabled: actions.cancelling }}
                onPress={actions.cancelling ? undefined : actions.cancel}
                style={[styles.link, actions.cancelling && styles.disabled]}
              >
                {t('chat.usageLimit.autoContinueCancel', "Don't continue")}
              </Text>
            </>
          ) : null}
        </Text>
      ) : null}
      {actions?.cancelFailed ? (
        <Text style={meta}>
          {t(
            'chat.usageLimit.autoContinueCancelFailed',
            "Couldn't cancel automatic continuation. Try again."
          )}
        </Text>
      ) : null}
      {continueNow || switchAccount ? (
        <View style={styles.pills}>
          {continueNow ? (
            <MobileNativeChatNoticePill
              label={t('common.continue', 'Continue')}
              Icon={Play}
              onPress={continueNow}
            />
          ) : null}
          {switchAccount ? (
            <MobileNativeChatNoticePill
              label={t('chat.usageLimit.switchAccount', 'Switch Account')}
              Icon={ArrowLeftRight}
              onPress={switchAccount}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  block: {
    marginTop: spacing.xs,
    gap: spacing.sm
  },
  meta: {
    color: colors.textMuted
  },
  link: {
    color: colors.textSecondary,
    textDecorationLine: 'underline'
  },
  disabled: {
    opacity: feedback.disabledOpacity
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  }
}))
