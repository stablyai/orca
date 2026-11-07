import { Presence } from '../components/AutoHeight'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { formatWorkerAutoCloseCountdown } from '../../../src/shared/worker-auto-close'
import { useMobileWorkerAutoClose, workerSubjectOf } from './mobile-worker-auto-close'
import type { MobileSessionController } from './use-mobile-session-controller'

/** Above a temporary orchestration worker's terminal or chat: when it closes, and Keep open. */
export function MobileWorkerAutoCloseStrip({
  controller
}: {
  controller: MobileSessionController
}) {
  const t = useMobileTranslation()
  const { client, connState, sessionTabs, activeSessionTabId } = controller
  const subject = workerSubjectOf(sessionTabs.find((tab) => tab.id === activeSessionTabId))
  const { state, nowMs, keepOpen } = useMobileWorkerAutoClose(client, connState, subject)
  const message =
    !state || state.kept
      ? null
      : state.closesAt === null
        ? t(
            'session.workerAutoClose.running',
            'Temporary orchestration worker · Closes 2 minutes after it finishes'
          )
        : t(
            'session.workerAutoClose.finished',
            'Temporary orchestration worker finished · Closes in {{countdown}}',
            { countdown: formatWorkerAutoCloseCountdown(state.closesAt, nowMs) }
          )
  // Fades without easing its height: the terminal under it refits on every resize.
  return (
    <Presence animateHeight={false}>
      {message !== null && (
        <HostRouteNoticeBanner
          message={message}
          action={{ label: t('session.workerAutoClose.keepOpen', 'Keep open'), onPress: keepOpen }}
        />
      )}
    </Presence>
  )
}
