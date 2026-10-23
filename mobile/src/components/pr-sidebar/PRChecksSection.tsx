import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { openExternalLink } from '../../platform/external-link'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ExternalLink,
  RotateCw,
  Sparkles
} from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { Button } from '../ui/Button'
import { Collapsible } from '../ui/Collapsible'
import { IconButton } from '../ui/IconButton'
import { slideTransition } from '../ui/transition-styles'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import type { RpcClient } from '../../transport/rpc-client'
import { fetchPRCheckDetails, type GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import {
  checkOutcome,
  checkOutcomeToken,
  checkStatusLabel,
  firstFailingCheckKey,
  prCheckKey,
  prChecksSummaryLabel,
  sortPRChecks,
  summarizePRChecks
} from './pr-checks-presentation'
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

// Checks summary (counts) + sorted per-check rows. Each row expands to lazily
// fetch github.prCheckDetails, cached per check key (U5). Display-only; the
// rerun action is U6.
export function PRChecksSection({
  checks,
  checksError,
  client,
  worktreeId,
  prRepo,
  actions,
  triage
}: Props) {
  const sorted = sortPRChecks(checks)
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
        // Why: a rejection must clear the entry's `loading` state, not leave it
        // spinning forever — fall back to an error detail.
        entry = {
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load check details'
        }
      }
      setDetailCache((prev) => ({ ...prev, [key]: entry }))
    },
    [client, worktreeId, prRepo]
  )

  // Fetch a check's detail the first time it expands; the loaded entry is the cache.
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

  // Auto-expand the first failing check once per loaded check set (parity with the
  // desktop ChecksList). Keyed on the sorted check identities so a worktree switch
  // or fresh load re-runs it, but the user's later manual collapses are not fought.
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

  const summaryToken = checkOutcomeToken(summary.outcome)
  const SummaryIcon =
    summary.failed > 0 ? AlertCircle : summary.outcome === 'success' ? CheckCircle2 : CircleDot
  const failing = triage !== undefined && summary.failed > 0

  return (
    <PRSection
      title="Checks"
      layout="rows"
      trailing={
        // Rerun is offered only when something failed; spinner-in-place while in flight.
        actions && summary.failed > 0 ? (
          <Button
            label="Rerun failed"
            icon={RotateCw}
            variant="plain"
            size="compact"
            busy={rerunBusy}
            onPress={() => actions.rerunFailingChecks()}
            accessibilityLabel="Rerun failing checks"
          />
        ) : undefined
      }
      footer={
        triage ? (
          <AgentLaunchNotice
            availability={summary.failed > 0 ? triage.availability : 'available'}
            success={triage.success}
            error={triage.error}
            warning={triage.warning}
            undeliveredPrompt={triage.undeliveredPrompt}
            errorStyle={triageStyles.triageError}
          />
        ) : undefined
      }
    >
      {/* The summary leads; when checks fail it carries the AI fix action (desktop PRTriageStrip). */}
      <View style={styles.row}>
        <SummaryIcon size={20} color={statusColor(summaryToken)} strokeWidth={2.2} />
        <View style={styles.rowMain}>
          <Text style={[styles.rowTitle, failing && styles.rowTitleStrong]} numberOfLines={1}>
            {failing
              ? `${summary.failed} failing check${summary.failed === 1 ? '' : 's'}`
              : prChecksSummaryLabel(summary, checksError)}
          </Text>
          {failing ? (
            <Text style={styles.rowSubtitle} numberOfLines={2}>
              Inspect details or start an AI fix pass.
            </Text>
          ) : null}
        </View>
        {failing ? (
          <Button
            label="Fix"
            icon={Sparkles}
            size="compact"
            busy={triage.isBusy}
            disabled={triage.availability !== 'available'}
            onPress={triage.fixChecks}
            accessibilityLabel="Fix failing checks with AI"
          />
        ) : null}
      </View>
      {checksError ? (
        <View style={styles.noteRow}>
          <Text style={[styles.noteRowText, { color: colors.danger }]}>{checksError}</Text>
        </View>
      ) : null}
      {sorted.map((check) => {
        const key = prCheckKey(check)
        const isOpen = expanded.has(key)
        const token = checkOutcomeToken(checkOutcome(check))
        const url = check.url
        return (
          <View key={key}>
            <Pressable
              onPress={() => toggle(check)}
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}
              accessibilityLabel={`${check.name} check details`}
            >
              {({ pressed }) => (
                <View style={[styles.row, styles.checkRow, pressed && styles.rowPressed]}>
                  <View
                    style={[isOpen ? styles.chevronOpen : styles.chevronClosed, slideTransition]}
                  >
                    <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
                  </View>
                  <View style={[styles.statusDot, { backgroundColor: statusColor(token) }]} />
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {check.name}
                    </Text>
                  </View>
                  {/* Status word + open-on-host (desktop ChecksList row), so the outcome reads without expanding. */}
                  <Text style={[styles.rowStatus, { color: statusColor(token) }]} numberOfLines={1}>
                    {checkStatusLabel(check)}
                  </Text>
                  {url ? (
                    <IconButton
                      icon={ExternalLink}
                      variant="bare"
                      iconSize={16}
                      iconColor={colors.textSecondary}
                      onPress={() => openExternalLink(url)}
                      accessibilityLabel={`Open ${check.name} on the web`}
                    />
                  ) : null}
                </View>
              )}
            </Pressable>
            <Collapsible open={isOpen}>
              <PRCheckDetailView entry={detailCache[key]} />
            </Collapsible>
          </View>
        )
      })}
    </PRSection>
  )
}
