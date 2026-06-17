import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, RotateCw } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../src/shared/types'
import type { RpcClient } from '../../transport/rpc-client'
import { fetchPRCheckDetails, type GitHubPrRepoSlug } from '../../session/github-pr-rpc'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import {
  checkOutcome,
  checkOutcomeToken,
  prCheckKey,
  sortPRChecks,
  summarizePRChecks
} from './pr-checks-presentation'
import { statusColor } from './pr-sidebar-status-color'
import { PRSection } from './PRSection'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  checks: PRCheckDetail[]
  client: RpcClient | null
  worktreeId: string
  prRepo?: GitHubPrRepoSlug | null
  // Optional so display-only usages (e.g. tests/storybook) can omit mutations.
  actions?: MobilePrActions
}

// Per-check lazily-fetched detail. `loading`/`error` track the in-flight fetch;
// `details` (once set) is the cache so collapse/re-expand never re-fetches.
type DetailEntry =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; details: PRCheckRunDetails | null }

// Checks summary (counts) + sorted per-check rows. Each row expands to lazily
// fetch github.prCheckDetails, cached per check key (U5). Display-only; the
// rerun action is U6.
export function PRChecksSection({ checks, client, worktreeId, prRepo, actions }: Props) {
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
      const outcome = await fetchPRCheckDetails(client, worktreeId, {
        checkRunId: check.checkRunId,
        workflowRunId: check.workflowRunId,
        checkName: check.name,
        url: check.url,
        prRepo
      })
      setDetailCache((prev) => ({
        ...prev,
        [key]: outcome.ok
          ? { status: 'loaded', details: outcome.result }
          : { status: 'error', message: outcome.error }
      }))
    },
    [client, worktreeId, prRepo]
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
      // Fetch only the first time a row expands; the loaded entry is the cache.
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
                <RotateCw size={14} color={colors.accentBlue} strokeWidth={2.2} />
              )}
            </Pressable>
          ) : null}
        </>
      }
    >
      {sorted.map((check) => {
        const key = prCheckKey(check)
        const isOpen = expanded.has(key)
        const token = checkOutcomeToken(checkOutcome(check))
        const Chevron = isOpen ? ChevronDown : ChevronRight
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
            </Pressable>
            {isOpen ? <CheckDetail entry={detailCache[key]} /> : null}
          </View>
        )
      })}
    </PRSection>
  )
}

function CheckDetail({ entry }: { entry: DetailEntry | undefined }) {
  if (!entry || entry.status === 'loading') {
    return (
      <View style={styles.checkDetailArea}>
        <ActivityIndicator color={colors.accentBlue} />
      </View>
    )
  }
  if (entry.status === 'error') {
    return (
      <View style={styles.checkDetailArea}>
        <Text style={styles.checkDetailText}>{entry.message}</Text>
      </View>
    )
  }
  const details = entry.details
  if (!details) {
    return (
      <View style={styles.checkDetailArea}>
        <Text style={styles.checkDetailText}>No details available.</Text>
      </View>
    )
  }
  const lines = [details.conclusion ?? details.status, details.title, details.summary].filter(
    (line): line is string => typeof line === 'string' && line.trim().length > 0
  )
  return (
    <View style={styles.checkDetailArea}>
      {lines.length === 0 ? (
        <Text style={styles.checkDetailText}>No details available.</Text>
      ) : (
        lines.map((line, index) => (
          <Text key={index} style={styles.checkDetailText}>
            {line}
          </Text>
        ))
      )}
    </View>
  )
}
