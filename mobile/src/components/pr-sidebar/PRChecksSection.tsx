import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, ExternalLink, RotateCw, Sparkles } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { PRCheckDetail } from '../../../../src/shared/types'
import type { RpcClient } from '../../transport/rpc-client'
import { fetchPRCheckDetails, type GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import {
  checkOutcome,
  checkOutcomeToken,
  checkStatusLabel,
  firstFailingCheckKey,
  prCheckKey,
  sortPRChecks,
  summarizePRChecks
} from './pr-checks-presentation'
import { statusColor } from './pr-sidebar-status-color'
import { PRSection } from './PRSection'
import { PRCheckDetailView, type DetailEntry } from './PRCheckDetail'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'
import { prAiTriageStyles as triageStyles } from './pr-ai-triage-styles'

// Launches the "Fix checks with AI" agent. Absent for display-only usages.
export type PrChecksTriage = {
  fixChecks: () => void
  isBusy: boolean
  error: string | null
}

type Props = {
  checks: PRCheckDetail[]
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
export function PRChecksSection({ checks, client, worktreeId, prRepo, actions, triage }: Props) {
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

  return (
    <PRSection
      title="Checks"
      trailing={
        <>
          <Text
            style={[
              styles.summaryLabel,
              { color: statusColor(checkOutcomeToken(summary.outcome)) }
            ]}
          >
            {summary.label}
          </Text>
          {/* Rerun is offered only when something failed; spinner-in-place while in-flight. */}
          {actions && summary.failed > 0 ? (
            <Pressable
              style={styles.iconButton}
              onPress={() => actions.rerunFailingChecks()}
              disabled={rerunBusy}
              accessibilityRole="button"
              accessibilityLabel="Rerun failing checks"
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
      {/* Triage strip at the top of the section (desktop PRTriageStrip): a failing
          summary + a Fix action, so the most actionable state leads the list. */}
      {triage && summary.failed > 0 ? (
        <View style={triageStyles.triageStrip}>
          <View style={triageStyles.triageStripText}>
            <Text style={triageStyles.triageStripTitle} numberOfLines={1}>
              {summary.failed} failing check{summary.failed === 1 ? '' : 's'}
            </Text>
            <Text style={triageStyles.triageStripSubtitle} numberOfLines={1}>
              Inspect details or start an AI fix pass.
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [triageStyles.triageStripButton, pressed && { opacity: 0.7 }]}
            onPress={triage.fixChecks}
            disabled={triage.isBusy}
            accessibilityRole="button"
            accessibilityLabel="Fix failing checks with AI"
          >
            {triage.isBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Sparkles size={13} color={colors.textSecondary} strokeWidth={2.2} />
            )}
            <Text style={triageStyles.triageStripButtonText}>Fix</Text>
          </Pressable>
        </View>
      ) : null}
      {triage?.error ? <Text style={triageStyles.triageError}>{triage.error}</Text> : null}
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
              accessibilityLabel={`${check.name} check details`}
            >
              <Chevron size={14} color={colors.textSecondary} strokeWidth={2.2} />
              <View style={[styles.statusDot, { backgroundColor: statusColor(token) }]} />
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {check.name}
                </Text>
              </View>
              {/* Status word + open-on-host icon (desktop ChecksList row), so the
                  outcome reads without expanding. */}
              <Text style={[styles.rowStatus, { color: statusColor(token) }]} numberOfLines={1}>
                {checkStatusLabel(check)}
              </Text>
              {url ? (
                <Pressable
                  style={styles.rowTrailing}
                  onPress={() => void Linking.openURL(url).catch(() => {})}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${check.name} on the web`}
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
