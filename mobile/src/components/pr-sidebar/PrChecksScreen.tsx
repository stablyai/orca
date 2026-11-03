import { useEffect, useMemo, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { ChevronDown, CircleCheck, CircleMinus, LoaderCircle } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { openExternalLink } from '../../platform/external-link'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import { isBrokenCheck } from '../../../../src/shared/pr-checks-fix-prompt'
import { sortChecksBySeverity } from '../../../../src/shared/pr-check-severity-order'
import { buildPrFixChecksPrompt } from '../../session/pr-ai-triage-prompt'
import { DisclosureChevron } from '../DisclosureChevron'
import { ListGroup, ListRow, SectionHeader, LIST_LEADING_INSET } from '../list/ListGroup'
import { AgentLaunchNotice } from '../AgentLaunchNotice'
import { checkOutcome, prCheckKey } from './pr-checks-presentation'
import { NotReady, ScreenFrame, type ScreenProps } from './pr-tab-screen-frame'
import { useHostProtocolGates } from '../host-protocol-gates-context'
import { useMobileLaunchAgentLabel } from '../../session/use-mobile-launch-agent-label'
import { readyPrData } from './use-mobile-pr-tab'
import { PrCheckFailureRow } from './PrCheckFailureRow'

const PREFETCHED_FAILURES = 3

export function PrChecksScreen({ tab, onBack, bottomInset = 0 }: ScreenProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const data = readyPrData(tab)
  const { checkDetails: cache, ensureCheckDetail: ensure } = tab
  const checks = useMemo(() => sortChecksBySeverity(data?.checks ?? []), [data?.checks])
  // Display follows the shared verdict (approval gates fail too); Fix and Rerun only offer what the host reruns.
  const failing = useMemo(
    () => checks.filter((check) => checkOutcome(check) === 'failure'),
    [checks]
  )
  const { hostCapabilities } = useHostProtocolGates()
  const fixAgent = useMobileLaunchAgentLabel({
    client: tab.client,
    worktreeId: tab.worktreeId,
    hostCapabilities,
    actionId: 'fixChecks',
    enabled: failing.length > 0
  })
  const fixLabel = fixAgent
    ? t('pullRequest.screens.fixWith', 'Fix with {{agent}}', { agent: fixAgent })
    : t('pullRequest.screens.fixWithAi', 'Fix with AI')
  const running = checks.filter((check) => checkOutcome(check) === 'pending')
  const passed = checks.filter((check) => checkOutcome(check) === 'success')
  const other = checks.filter((check) => checkOutcome(check) === 'neutral')
  const [showPassed, setShowPassed] = useState(false)

  // Open and prefetch only the first few failures; a wide matrix would otherwise fan out one host read per job.
  useEffect(() => {
    failing.slice(0, PREFETCHED_FAILURES).forEach(ensure)
  }, [ensure, failing])

  const fixChecks = (target: PRCheckDetail[]) => {
    if (data) {
      const { client, worktreeId } = tab
      void tab.triage.launch('fix-checks', () =>
        buildPrFixChecksPrompt({ client, worktreeId, pr: data.pr, checks: target })
      )
    }
  }
  const notice = tab.triage.noticeFor('fix-checks')

  return (
    <ScreenFrame
      title={t('pullRequest.checksSection.title', 'Checks')}
      subtitle={data ? `#${data.pr.number}` : undefined}
      onBack={onBack}
    >
      {!data ? (
        <NotReady tab={tab} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: bottomInset + spacing.lg }}>
          <ChecksSummary
            failing={failing.length}
            running={running.length}
            passed={passed.length}
            live={tab.polling}
            t={t}
          />
          {data.checksError ? <Text style={styles.note}>{data.checksError}</Text> : null}
          {data.checks.length === 0 && !data.checksError ? (
            <Text style={styles.muted}>{t('pullRequest.checksSection.noChecks', 'No checks')}</Text>
          ) : null}
          {failing.length > 0 ? (
            <View>
              <SectionHeader title={t('pullRequest.screens.failing', 'Failing')} />
              <ListGroup style={styles.plain} separatorInset={LIST_LEADING_INSET}>
                {failing.map((check, index) => (
                  <PrCheckFailureRow
                    key={prCheckKey(check)}
                    initiallyOpen={index < PREFETCHED_FAILURES}
                    onOpen={() => ensure(check)}
                    check={check}
                    entry={cache[prCheckKey(check)]}
                    actionable={isBrokenCheck(check)}
                    fixLabel={fixLabel}
                    onFix={() => fixChecks([check])}
                    fixBusy={tab.triage.isBusy('fix-checks')}
                    fixAvailable={tab.triage.availability === 'available'}
                    onRerun={tab.actions.rerunFailingChecks}
                    rerunBusy={tab.actions.isBusy({ kind: 'rerun' })}
                  />
                ))}
              </ListGroup>
              <View style={styles.notes}>
                <AgentLaunchNotice
                  availability={tab.triage.availability}
                  success={notice.success}
                  error={notice.error}
                  warning={notice.warning}
                  undeliveredPrompt={notice.undeliveredPrompt}
                  errorStyle={styles.error}
                />
                {tab.actions.error ? <Text style={styles.error}>{tab.actions.error}</Text> : null}
              </View>
            </View>
          ) : null}
          {running.length > 0 ? (
            <View>
              <SectionHeader title={t('pullRequest.screens.runningSection', 'Running')} />
              <ListGroup style={styles.plain} separatorInset={LIST_LEADING_INSET}>
                {running.map((check) => (
                  <CheckRow
                    key={prCheckKey(check)}
                    check={check}
                    tone="running"
                    subtitle={
                      check.status === 'queued'
                        ? t('pullRequest.screens.queued', 'Queued')
                        : t('pullRequest.screens.inProgress', 'In progress')
                    }
                  />
                ))}
              </ListGroup>
            </View>
          ) : null}
          {passed.length > 0 ? (
            <View>
              <SectionHeader title={t('pullRequest.screens.passedSection', 'Passed')} />
              <ListGroup style={styles.plain} separatorInset={LIST_LEADING_INSET}>
                <ListRow
                  key="passed"
                  title={t('pullRequest.checksSection.passed', '{{count}} passed', {
                    count: passed.length
                  })}
                  subtitle={showPassed ? undefined : foldedNames(passed, t)}
                  leading={<CircleCheck size={20} color={colors.statusGreen} strokeWidth={2} />}
                  accessory={
                    <DisclosureChevron expanded={showPassed} collapsedDeg={0} expandedDeg={180}>
                      <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
                    </DisclosureChevron>
                  }
                  onPress={() => setShowPassed((value) => !value)}
                />
                {showPassed
                  ? passed.map((check) => (
                      <CheckRow key={prCheckKey(check)} check={check} tone="passed" />
                    ))
                  : null}
              </ListGroup>
            </View>
          ) : null}
          {other.length > 0 ? (
            <View>
              <SectionHeader title={t('pullRequest.screens.neutralSection', 'Neutral')} />
              <ListGroup style={styles.plain} separatorInset={LIST_LEADING_INSET}>
                {other.map((check) => (
                  <CheckRow key={prCheckKey(check)} check={check} tone="other" />
                ))}
              </ListGroup>
            </View>
          ) : null}
        </ScrollView>
      )}
    </ScreenFrame>
  )
}

function foldedNames(checks: PRCheckDetail[], t: Translate): string {
  const shown = checks.slice(0, 3).map((check) => check.name)
  const rest = checks.length - shown.length
  return rest > 0
    ? t('pullRequest.screens.namesAndMore', '{{names}} and {{count}} more', {
        names: shown.join(', '),
        count: rest
      })
    : shown.join(', ')
}

// A bar split by outcome, then the counts in words, so the state reads before any row.
function ChecksSummary({
  failing,
  running,
  passed,
  live,
  t
}: {
  failing: number
  running: number
  passed: number
  // The screen polls while it is open, so it says so instead of offering a refresh button.
  live: boolean
  t: Translate
}) {
  useMobileColorScheme()
  if (failing + running + passed === 0) {
    return null
  }
  const rest = [
    running > 0 ? t('pullRequest.screens.running', '{{count}} running', { count: running }) : null,
    passed > 0 ? t('pullRequest.checksSection.passed', '{{count}} passed', { count: passed }) : null
  ].filter(Boolean)
  return (
    <View style={styles.summary}>
      <View style={styles.bar}>
        {failing > 0 ? (
          <View style={[styles.segment, styles.segmentFailing, { flex: failing }]} />
        ) : null}
        {running > 0 ? (
          <View style={[styles.segment, styles.segmentRunning, { flex: running }]} />
        ) : null}
        {passed > 0 ? (
          <View style={[styles.segment, styles.segmentPassed, { flex: passed }]} />
        ) : null}
      </View>
      <View style={styles.countsRow}>
        <Text style={styles.counts}>
          {failing > 0 ? (
            <Text style={styles.countsFailing}>
              {t('pullRequest.checksSection.failing', '{{count}} failing', { count: failing })}
            </Text>
          ) : null}
          {failing > 0 && rest.length > 0 ? ' · ' : ''}
          {rest.join(' · ')}
        </Text>
        {live ? (
          <View style={styles.live}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t('pullRequest.screens.live', 'Live')}</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}

function CheckRow({
  check,
  tone,
  subtitle
}: {
  check: PRCheckDetail
  tone: 'running' | 'passed' | 'other'
  subtitle?: string
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const Icon = tone === 'running' ? LoaderCircle : tone === 'passed' ? CircleCheck : CircleMinus
  const color =
    tone === 'running'
      ? colors.statusAmber
      : tone === 'passed'
        ? colors.statusGreen
        : colors.textMuted
  const url = check.url
  return (
    <ListRow
      title={check.name}
      subtitle={subtitle}
      leading={<Icon size={20} color={color} strokeWidth={2} />}
      navigates={url !== null}
      onPress={url ? () => openExternalLink(url) : undefined}
      accessibilityRole={url ? 'link' : undefined}
      accessibilityLabel={
        url
          ? t('pullRequest.checksSection.openOnWeb', 'Open {{name}} on the web', {
              name: check.name
            })
          : check.name
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  plain: { backgroundColor: 'transparent', borderRadius: 0 },
  summary: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm },
  bar: { flexDirection: 'row', gap: 3, height: 4 },
  segment: { borderRadius: radii.pill },
  segmentFailing: { backgroundColor: colors.statusRed },
  segmentRunning: { backgroundColor: colors.statusAmber },
  segmentPassed: { backgroundColor: colors.statusGreen },
  counts: { flexShrink: 1, color: colors.textSecondary, fontSize: typography.metaSize },
  countsFailing: { color: colors.statusRed, fontWeight: '600' },
  countsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  live: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  liveDot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: colors.statusGreen },
  liveText: { color: colors.textSecondary, fontSize: typography.metaSize },
  notes: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  note: { color: colors.statusRed, fontSize: 13, paddingHorizontal: spacing.lg },
  muted: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  },
  error: { color: colors.statusRed, fontSize: 13 }
}))
