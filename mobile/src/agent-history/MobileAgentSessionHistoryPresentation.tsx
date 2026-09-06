import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import type { AiVaultSessionDisplayTurn } from '../../../src/shared/ai-vault-session-display'
import type { AiVaultScope } from '../../../src/shared/ai-vault-types'
import { colors } from '../theme/mobile-theme'
import { shouldShowMobileCurrentWorktreeBadge } from './agent-history-current-worktree-badge'
import type { MobileAgentHistorySection } from './agent-history-sections'
import type { MobileAgentHistoryResumeActionState } from './agent-history-session-card'
import { styles } from './agent-history-styles'
import { MobileAgentSessionHistoryList } from './MobileAgentSessionHistoryList'

const SCOPE_TABS: { scope: AiVaultScope; label: string }[] = [
  { scope: 'workspace', label: 'Workspace' },
  { scope: 'project', label: 'Project' },
  { scope: 'all', label: 'All' }
]

export type MobileAgentHistoryPresentationState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      sections: MobileAgentHistorySection[]
      skippedTranscriptCount: number
    }

export function MobileAgentSessionHistoryPresentation({
  worktreeLabel,
  scope,
  state,
  refreshing,
  query,
  resumeMessage,
  resumeActionStateBySessionId,
  onBack,
  onRefresh,
  onRetry,
  onSelectScope,
  onChangeQuery,
  loadPreview,
  onResume
}: {
  worktreeLabel: string
  scope: AiVaultScope
  state: MobileAgentHistoryPresentationState
  refreshing: boolean
  query: string
  resumeMessage: string | null
  resumeActionStateBySessionId: ReadonlyMap<string, MobileAgentHistoryResumeActionState>
  onBack: () => void
  onRefresh: () => void
  onRetry: () => void
  onSelectScope: (scope: AiVaultScope) => void
  onChangeQuery: (query: string) => void
  loadPreview: (sessionId: string) => Promise<AiVaultSessionDisplayTurn[]>
  onResume: (sessionId: string) => void | Promise<void>
}) {
  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={onBack}
            hitSlop={8}
            accessibilityLabel="Back"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              Agent Session History
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {worktreeLabel}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}
            onPress={onRefresh}
            hitSlop={8}
            accessibilityLabel="Refresh agent sessions"
          >
            <RefreshCw size={18} color={colors.textSecondary} strokeWidth={2.1} />
          </Pressable>
        </View>
      </SafeAreaView>

      {state.kind === 'loading' ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : state.kind === 'unsupported' ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>Agent Session History Unavailable</Text>
          <Text style={styles.stateText}>
            Update Orca on this host to browse agent session history.
          </Text>
        </View>
      ) : state.kind === 'error' ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>Unable to Load</Text>
          <Text style={styles.stateText}>{state.message}</Text>
          <Pressable style={styles.retryButton} onPress={onRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.scopeTabs}>
            {SCOPE_TABS.map((tab) => {
              const active = scope === tab.scope
              return (
                <Pressable
                  key={tab.scope}
                  style={[styles.scopeTab, active && styles.scopeTabActive]}
                  onPress={() => onSelectScope(tab.scope)}
                >
                  <Text style={[styles.scopeTabText, active && styles.scopeTabTextActive]}>
                    {tab.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={onChangeQuery}
              placeholder="Search sessions, repo:, path:"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {state.skippedTranscriptCount > 0 ? (
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeText}>
                {state.skippedTranscriptCount}{' '}
                {state.skippedTranscriptCount === 1 ? 'transcript' : 'transcripts'} skipped
              </Text>
            </View>
          ) : null}
          {resumeMessage ? (
            <View style={styles.resumeBanner}>
              <Text style={styles.resumeBannerText}>{resumeMessage}</Text>
            </View>
          ) : null}
          {state.sections.length === 0 ? (
            <View style={styles.state}>
              <Text style={styles.stateTitle}>No agent sessions</Text>
              <Text style={styles.stateText}>
                {query ? 'No sessions match your search.' : 'No past agent sessions in this scope.'}
              </Text>
            </View>
          ) : (
            <MobileAgentSessionHistoryList
              sections={state.sections}
              refreshing={refreshing}
              showCurrentWorktreeBadges={shouldShowMobileCurrentWorktreeBadge(scope)}
              resumeActionStateBySessionId={resumeActionStateBySessionId}
              loadPreview={loadPreview}
              onResume={onResume}
              onRefresh={onRefresh}
            />
          )}
        </>
      )}
    </View>
  )
}
