import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import type { PrSidebarState } from '../../session/mobile-pr-sidebar-state'
import type { PrSidebarLoadOptions } from '../../session/use-mobile-pr-sidebar-controller'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import type { MobilePrCommentActions } from '../../session/use-mobile-pr-comment-actions'
import type { MobilePrTitleAction } from '../../session/use-mobile-pr-title-action'
import type { MobilePrAiTriage } from '../../session/use-mobile-pr-ai-triage'
import type { MobilePrFileViewed } from '../../session/use-mobile-pr-file-viewed'
import {
  buildFixChecksPrompt,
  buildResolveConflictsPrompt
} from '../../session/pr-ai-triage-prompt'
import { fetchPRCheckDetails } from '../../session/github-pr-rpc'
import { getBrokenChecks, hasGitHubCheckHandle } from '../../../../src/shared/pr-checks-fix-prompt'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'
import { prActionsStyles as actionStyles } from './pr-actions-styles'
import { hubStyles } from '../../source-control/mobile-source-control-hub-styles'
import { PRSidebarHeader } from './PRSidebarHeader'
import { PRConflictingFilesSection } from './PRConflictingFilesSection'
import { PRActionsSection } from './PRActionsSection'
import { PRReviewersSection } from './PRReviewersSection'
import { PRChecksSection } from './PRChecksSection'
import { PRCommentsSection } from './PRCommentsSection'
import { PRFilesTab } from './PRFilesTab'
import { PRViewTabs, type PRViewTab } from './PRViewTabs'

const NO_COMMENTS: never[] = []

function TabScroll({ bottomInset, children }: { bottomInset: number; children: ReactNode }) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      // Inset scroll for keyboard or bottom root/reply composers remain covered.
      automaticallyAdjustKeyboardInsets
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  )
}

export function PRViewSections({
  data,
  client,
  worktreeId,
  actions,
  commentActions,
  titleAction,
  triage,
  refetch,
  showOpenOnWeb,
  botAuthorOverrides,
  bottomInset,
  onOpenPrFile,
  prFileViewed: viewed
}: {
  data: Extract<PrSidebarState, { kind: 'ready' }>['data']
  client: RpcClient | null
  worktreeId: string
  actions: MobilePrActions
  commentActions: MobilePrCommentActions
  titleAction: MobilePrTitleAction
  triage: MobilePrAiTriage
  refetch: (options?: PrSidebarLoadOptions) => void
  showOpenOnWeb: boolean
  botAuthorOverrides: ReadonlySet<string>
  bottomInset: number
  onOpenPrFile?: (path: string) => void
  prFileViewed: MobilePrFileViewed
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [tab, setTab] = useState<PRViewTab>('overview')
  // Keep visited tabs mounted so a half-written comment survives a look at Files.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<PRViewTab>>(
    () => new Set<PRViewTab>(['overview'])
  )
  const selectTab = (next: PRViewTab) => {
    setTab(next)
    setVisitedTabs((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
  }
  const pr = data.pr
  const details = data.details
  const comments = details?.comments
  const retryDetails = useCallback(() => refetch({ includeDetails: true }), [refetch])
  const failingCheckCount = useMemo(() => getBrokenChecks(data.checks).length, [data.checks])

  // Build pure triage prompts lazily at launch so each uses current PR data.
  const checksTriage = {
    fixChecks: () =>
      void triage.launch('fix-checks', () =>
        buildFixChecksPrompt({
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.url,
          checks: data.checks,
          loadCheckDetails: async (check) => {
            if (!client || !hasGitHubCheckHandle(check)) {
              return null
            }
            const outcome = await fetchPRCheckDetails(client, worktreeId, {
              checkRunId: check.checkRunId,
              workflowRunId: check.workflowRunId,
              checkName: check.name,
              url: check.url,
              prRepo: pr.prRepo ?? null
            })
            return outcome.ok ? outcome.result : null
          }
        })
      ),
    isBusy: triage.isBusy('fix-checks'),
    availability: triage.availability,
    ...triage.noticeFor('fix-checks')
  }
  const conflictsTriage = {
    resolveConflicts: () =>
      void triage.launch('resolve-conflicts', () =>
        buildResolveConflictsPrompt({
          prNumber: pr.number,
          baseRef: pr.conflictSummary?.baseRef ?? pr.baseRefName ?? null,
          files: pr.conflictSummary?.files ?? [],
          worktreeId
        })
      ),
    isBusy: triage.isBusy('resolve-conflicts'),
    availability: triage.availability,
    ...triage.noticeFor('resolve-conflicts')
  }

  const renderTab = (value: PRViewTab) => {
    switch (value) {
      case 'overview':
        // Combine ready PR identity/actions in one card to avoid duplicate badge/title/branch/action bands.
        return (
          <TabScroll bottomInset={bottomInset}>
            <View style={styles.section}>
              <View style={styles.sectionBody}>
                <PRSidebarHeader
                  pr={pr}
                  details={details}
                  titleAction={titleAction}
                  showOpenOnWeb={showOpenOnWeb}
                  bare
                />
                <PRActionsSection
                  pr={pr}
                  actions={actions}
                  client={client}
                  worktreeId={worktreeId}
                  onUnlinked={refetch}
                  onRecheck={() => refetch({ includeDetails: false })}
                />
              </View>
            </View>
            {/* Own titled section when present; null otherwise (no empty chrome). */}
            <PRConflictingFilesSection pr={pr} triage={conflictsTriage} />
            <PRReviewersSection
              details={details}
              actions={actions}
              client={client}
              worktreeId={worktreeId}
            />
          </TabScroll>
        )
      case 'files':
        return (
          <PRFilesTab
            files={details?.files}
            detailsLoaded={details !== null}
            filesUnavailable={details?.filesUnavailable === true}
            comments={comments ?? NO_COMMENTS}
            canMarkViewed={viewed.canSync}
            pendingViewedPaths={viewed.pendingPaths}
            viewedError={viewed.error}
            onToggleViewed={viewed.setViewed}
            onOpenFile={onOpenPrFile}
            onRetry={retryDetails}
            bottomInset={bottomInset}
          />
        )
      case 'comments':
        return (
          <TabScroll bottomInset={bottomInset}>
            <PRCommentsSection
              details={details}
              prState={pr.state}
              prRepo={pr.prRepo ?? null}
              actions={commentActions}
              botAuthorOverrides={botAuthorOverrides}
            />
          </TabScroll>
        )
      case 'checks':
        return (
          <TabScroll bottomInset={bottomInset}>
            {/* Rerun reports through the shared actions engine, whose error line otherwise sits on Overview. */}
            {actions.error ? (
              <Text style={[actionStyles.actionError, styles.sectionBody]}>{actions.error}</Text>
            ) : null}
            <PRChecksSection
              checks={data.checks}
              checksError={data.checksError}
              client={client}
              worktreeId={worktreeId}
              prRepo={pr.prRepo ?? null}
              actions={actions}
              triage={checksTriage}
            />
          </TabScroll>
        )
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <PRViewTabs
        active={tab}
        onSelect={selectTab}
        tabs={[
          { value: 'overview', label: t('components.prView.overview', 'Overview') },
          {
            value: 'files',
            label: t('components.prView.files', 'Files'),
            count: details?.files?.length
          },
          {
            value: 'comments',
            label: t('components.prView.comments', 'Comments'),
            count: comments?.length
          },
          {
            value: 'checks',
            label: t('components.prView.checks', 'Checks'),
            count: data.checks.length,
            alert: failingCheckCount > 0
          }
        ]}
      />
      {(['overview', 'files', 'comments', 'checks'] as const)
        .filter((value) => visitedTabs.has(value))
        .map((value) => (
          <View key={value} style={value === tab ? hubStyles.tabBody : hubStyles.tabBodyHidden}>
            {renderTab(value)}
          </View>
        ))}
    </View>
  )
}
