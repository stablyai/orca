import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { openExternalLink } from '../../platform/external-link'
import { ChevronDown, ChevronRight, ExternalLink, RotateCw, Sparkles } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { translate } from '../../i18n/mobile-i18n'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import type { RpcClient } from '../../transport/rpc-client'
import { fetchPRCheckDetails, type GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import {
  checkOutcome,
  checkOutcomeToken,
  firstFailingCheckKey,
  prCheckKey,
  summarizePRChecks,
  type PRChecksSummary
} from './pr-checks-presentation'
import { sortChecksBySeverity } from '../../../../src/shared/pr-check-severity-order'
import { getBrokenChecks } from '../../../../src/shared/pr-checks-fix-prompt'
import { getCheckConclusion } from '../../../../src/shared/pr-check-status-label'
import { statusColor } from './pr-sidebar-status-color'
import { PRSection } from './PRSection'
import { PRCheckDetailView, type DetailEntry } from './PRCheckDetail'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'
import { prAiTriageStyles as triageStyles } from './pr-ai-triage-styles'
import { AgentLaunchNotice } from '../AgentLaunchNotice'
import type { MobileAgentLaunchAvailability } from '../../session/mobile-agent-launch-availability'

// Launches the "Fix checks with AI" agent. Absent for display-only usages.
export type PrChecksTriage = {
  fixChecks: () => void
  isBusy: boolean
  availability: MobileAgentLaunchAvailability
  success: string | null
  error: string | null
  warning: string | null
  undeliveredPrompt: string | null
}

type Props = {
  checks: PRCheckDetail[]
  // Set when the checks read failed; the section shows it in place of the rows.
  checksError: string | null
  client: RpcClient | null
  worktreeId: string
  prRepo?: GitHubPrRepoSlug | null
  // Optional so display-only usages (e.g. tests/storybook) can omit mutations.
  actions?: MobilePrActions
  triage?: PrChecksTriage
}

function checksSummaryLabel(summary: PRChecksSummary, checksError: string | null, t: Translate) {
  if (checksError !== null) {
    return t('pullRequest.checksSection.unavailable', 'Checks unavailable')
  }
  if (summary.total === 0) {
    return t('pullRequest.checksSection.noChecks', 'No checks')
  }
  const parts: string[] = []
  if (summary.failed > 0) {
    parts.push(
      t('pullRequest.checksSection.failing', '{{count}} failing', { count: summary.failed })
    )
  }
  if (summary.pending > 0) {
    parts.push(
      t('pullRequest.checksSection.pendingCount', '{{count}} pending', { count: summary.pending })
    )
  }
  if (summary.passed > 0) {
    parts.push(t('pullRequest.checksSection.passed', '{{count}} passed', { count: summary.passed }))
  }
  const neutral = summary.total - summary.failed - summary.pending - summary.passed
  if (neutral > 0) {
    parts.push(t('pullRequest.checksSection.neutralCount', '{{count}} neutral', { count: neutral }))
  }
  return parts.join(' · ')
}

function checkStatusLabel(check: PRCheckDetail, t: Translate): string {
  switch (getCheckConclusion(check)) {
    case 'success':
      return t('pullRequest.checksSection.successful', 'Successful')
    case 'failure':
      return t('pullRequest.checksSection.failed', 'Failed')
    case 'cancelled':
      return t('pullRequest.checksSection.cancelled', 'Cancelled')
    case 'timed_out':
      return t('pullRequest.checksSection.timedOut', 'Timed out')
    case 'action_required':
      return t('pullRequest.checksSection.actionRequired', 'Action required')
    case 'neutral':
      return t('pullRequest.checksSection.neutral', 'Neutral')
    case 'skipped':
      return t('pullRequest.checksSection.skipped', 'Skipped')
    case 'pending':
      break
  }
  if (check.status === 'queued') {
    return t('pullRequest.checksSection.queued', 'Queued')
  }
  if (check.status === 'in_progress') {
    return t('pullRequest.checksSection.inProgress', 'In progress')
  }
  return t('pullRequest.checksSection.pending', 'Pending')
}

// Sort summary/check rows; lazily cache expanded github.prCheckDetails per check key. Rerun action is separate.
export function PRChecksSection({
  checks,
  checksError,
  client,
  worktreeId,
  prRepo,
  actions,
  triage
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const sorted = sortChecksBySeverity(checks)
  // Desktop gates Fix and Rerun on the checks the host reruns and the prompt lists.
  const count = getBrokenChecks(checks).length
  const summary = summarizePRChecks(checks)
  const rerunBusy = actions?.isBusy({ kind: 'rerun' }) ?? false
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [detailCache, setDetailCache] = useState<Record<string, DetailEntry>>({})

  const loadDetail = useCallback(
    async (check: PRCheckDetail, key: string) => {
      if (!client) {
        return
      }
      let entry: DetailEntry
      try {
        const outcome = await fetchPRCheckDetails(client, worktreeId, {
          checkRunId: check.checkRunId,
          workflowRunId: check.workflowRunId,
          checkName: check.name,
          url: check.url,
          prRepo
        })
        entry = outcome.ok
          ? { status: 'loaded', details: outcome.result }
          : { status: 'error', message: outcome.error }
      } catch (err) {
        // Set error detail on rejection so loading cannot spin forever.
        entry = {
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : translate(
                  'pullRequest.checksSection.loadDetailsFailed',
                  'Failed to load check details'
                )
        }
      }
      setDetailCache((prev) => ({ ...prev, [key]: entry }))
    },
    [client, worktreeId, prRepo]
  )

  const ensureDetail = useCallback(
    (check: PRCheckDetail, key: string) => {
      setDetailCache((prev) => {
        if (prev[key] || !client) {
          return prev
        }
        void loadDetail(check, key)
        return { ...prev, [key]: { status: 'loading' } }
      })
    },
    [client, loadDetail]
  )

  const toggle = useCallback(
    (check: PRCheckDetail) => {
      const key = prCheckKey(check)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) {
          next.delete(key)
          return next
        }
        next.add(key)
        return next
      })
      ensureDetail(check, key)
    },
    [ensureDetail]
  )

  // Auto-expand first failure once per sorted identity set; reset on worktree/fresh load without overriding later user collapse.
  const autoExpandedSignatureRef = useRef<string | null>(null)
  const sortedSignature = sorted.map(prCheckKey).join('|')
  useEffect(() => {
    if (autoExpandedSignatureRef.current === sortedSignature) {
      return
    }
    autoExpandedSignatureRef.current = sortedSignature
    const key = firstFailingCheckKey(sorted)
    if (!key) {
      return
    }
    const failing = sorted.find((check) => prCheckKey(check) === key)
    if (!failing) {
      return
    }
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    ensureDetail(failing, key)
  }, [ensureDetail, sorted, sortedSignature])

  return (
    <PRSection
      title={t('pullRequest.checksSection.title', 'Checks')}
      trailing={
        <>
          <Text
            style={[
              styles.summaryLabel,
              { color: statusColor(checkOutcomeToken(summary.outcome)) }
            ]}
          >
            {checksSummaryLabel(summary, checksError, t)}
          </Text>
          {/* Rerun is offered only when something failed; spinner-in-place while in-flight. */}
          {actions && count > 0 ? (
            <Pressable
              style={styles.iconButton}
              onPress={() => actions.rerunFailingChecks()}
              disabled={rerunBusy}
              accessibilityRole="button"
              accessibilityLabel={t(
                'pullRequest.checksSection.rerunFailing',
                'Rerun failing checks'
              )}
            >
              {rerunBusy ? (
                <ActivityIndicator color={colors.textSecondary} />
              ) : (
                <RotateCw size={14} color={colors.textSecondary} strokeWidth={2.2} />
              )}
            </Pressable>
          ) : null}
        </>
      }
    >
      {/* Lead with desktop-style failing summary and Fix action so actionable state comes first. */}
      {triage && count > 0 ? (
        <View style={triageStyles.triageStrip}>
          <View style={triageStyles.triageStripText}>
            <Text style={triageStyles.triageStripTitle} numberOfLines={1}>
              {count === 1
                ? t('pullRequest.checksSection.failingChecks_one', '{{count}} failing check', {
                    count
                  })
                : t('pullRequest.checksSection.failingChecks_other', '{{count}} failing checks', {
                    count
                  })}
            </Text>
            <Text style={triageStyles.triageStripSubtitle} numberOfLines={1}>
              {t(
                'pullRequest.checksSection.inspectOrFix',
                'Inspect details or start an AI fix pass.'
              )}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [triageStyles.triageStripButton, pressed && { opacity: 0.7 }]}
            onPress={triage.fixChecks}
            disabled={triage.isBusy || triage.availability !== 'available'}
            accessibilityRole="button"
            accessibilityLabel={t(
              'pullRequest.checksSection.fixFailing',
              'Fix failing checks with AI'
            )}
          >
            {triage.isBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Sparkles size={13} color={colors.textSecondary} strokeWidth={2.2} />
            )}
            <Text style={triageStyles.triageStripButtonText}>
              {t('pullRequest.checksSection.fix', 'Fix')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {triage ? (
        <AgentLaunchNotice
          availability={summary.failed > 0 ? triage.availability : 'available'}
          success={triage.success}
          error={triage.error}
          warning={triage.warning}
          undeliveredPrompt={triage.undeliveredPrompt}
          errorStyle={triageStyles.triageError}
        />
      ) : null}
      {checksError ? <Text style={triageStyles.triageError}>{checksError}</Text> : null}
      {sorted.map((check) => {
        const key = prCheckKey(check)
        const isOpen = expanded.has(key)
        const token = checkOutcomeToken(checkOutcome(check))
        const Chevron = isOpen ? ChevronDown : ChevronRight
        const url = check.url
        return (
          <View key={key}>
            <Pressable
              style={styles.row}
              onPress={() => toggle(check)}
              accessibilityRole="button"
              accessibilityLabel={t(
                'pullRequest.checksSection.checkDetails',
                '{{name}} check details',
                { name: check.name }
              )}
            >
              <Chevron size={14} color={colors.textSecondary} strokeWidth={2.2} />
              <View style={[styles.statusDot, { backgroundColor: statusColor(token) }]} />
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {check.name}
                </Text>
              </View>
              {/* Show status word/open-on-host without requiring expansion, matching desktop. */}
              <Text style={[styles.rowStatus, { color: statusColor(token) }]} numberOfLines={1}>
                {checkStatusLabel(check, t)}
              </Text>
              {url ? (
                <Pressable
                  style={styles.rowTrailing}
                  onPress={() => openExternalLink(url)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'pullRequest.checksSection.openOnWeb',
                    'Open {{name}} on the web',
                    { name: check.name }
                  )}
                >
                  <ExternalLink size={13} color={colors.textSecondary} strokeWidth={2.2} />
                </Pressable>
              ) : null}
            </Pressable>
            {isOpen ? <PRCheckDetailView entry={detailCache[key]} /> : null}
          </View>
        )
      })}
    </PRSection>
  )
}
