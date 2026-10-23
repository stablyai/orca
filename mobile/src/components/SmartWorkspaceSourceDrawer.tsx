import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { SmartWorkspaceSourceRow as SourceRow } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type { JiraSite, JiraSiteSelection } from '../../../src/shared/jira-types'
import { isBlockingJiraUrlIntent } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import {
  MR_STATE_FILTER_OPTIONS,
  resolveAvailableSmartModes,
  resolveDefaultSmartMode,
  SMART_MODE_OPTIONS,
  type SmartModeAvailabilityInput,
  type SmartModeOption
} from '../tasks/mobile-smart-source-modes'
import type { MrStateFilter, SmartNameMode } from '../tasks/mobile-composer-source-types'
import {
  lookupGitHubItemByOwnerRepo,
  type PasteRepoCandidate
} from '../tasks/smart-source-paste-intent'
import { useSmartWorkspaceSource } from '../tasks/use-smart-workspace-source'
import type { MobileComposerSource } from '../tasks/use-mobile-composer-source'
import { colors } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { MobileSegmentedControl } from './MobileSegmentedControl'
import { smartWorkspaceSourceDrawerStyles as styles } from './smart-workspace-source-drawer-styles'
import { SmartWorkspaceSourceRow } from './SmartWorkspaceSourceRow'
import { Banner } from './ui/Banner'
import { FilterChip } from './ui/FilterChip'
import { SheetHeader } from './ui/SheetHeader'
import { TextField } from './ui/TextField'

// Why: match MobileSearchField — native autoFocus alone often fails to raise
// the soft keyboard when the drawer is mid-present animation.
const SOURCE_INPUT_FOCUS_DELAY_MS = 120

type Props = {
  visible: boolean
  client: RpcClient | null
  composer: MobileComposerSource
  availability: SmartModeAvailabilityInput
  repoId: string | null
  repos: readonly PasteRepoCandidate[]
  linearWorkspaceId?: string | null
  jiraSiteId?: JiraSiteSelection | null
  jiraSites?: readonly JiraSite[]
  sshReady: boolean
  onRepoChange: (repoId: string) => void
  onClose: () => void
}

const NO_JIRA_SITES: readonly JiraSite[] = []

export function SmartWorkspaceSourceDrawer({
  visible,
  client,
  composer,
  availability,
  repoId,
  repos,
  linearWorkspaceId,
  jiraSiteId,
  jiraSites = NO_JIRA_SITES,
  sshReady,
  onRepoChange,
  onClose
}: Props) {
  const availableModes = useMemo(() => resolveAvailableSmartModes(availability), [availability])
  const [mode, setMode] = useState<SmartNameMode>(() => resolveDefaultSmartMode(availability))
  const [mrStateFilter, setMrStateFilter] = useState<MrStateFilter>('opened')
  const inputRef = useRef<TextInput>(null)
  // Why: read latest availability inside the open effect without making it a
  // reactive dep (the object is recreated each render), so re-seeding happens
  // only on open, not on every availability recompute.
  const availabilityRef = useRef(availability)
  availabilityRef.current = availability

  // Reset to the default mode each time the drawer opens.
  useEffect(() => {
    if (visible) {
      setMode(resolveDefaultSmartMode(availabilityRef.current))
    }
  }, [visible])

  // Why: focus after open interactions settle so the keyboard appears and the
  // caret lands in the docked field (same value as the form via composer.name).
  useEffect(() => {
    if (!visible) {
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const task = InteractionManager.runAfterInteractions(() => {
      timeout = setTimeout(() => {
        inputRef.current?.focus()
      }, SOURCE_INPUT_FOCUS_DELAY_MS)
    })
    return () => {
      task.cancel()
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [visible])

  // Snap the chosen mode back into the available set if availability changes.
  const effectiveMode = availableModes.includes(mode) ? mode : (availableModes[0] ?? 'text')

  // A pasted Jira URL resolves to one issue without touching the repo, so it must
  // stay reachable from Smart mode even when the repo is not connected.
  const jiraUrlIntent =
    availability.jiraAvailable && isBlockingJiraUrlIntent(effectiveMode, composer.name)
  // Linear and Jira search without a repo; every other provider/branch search
  // needs a connected repo-backed target.
  const searchEnabled =
    visible && (effectiveMode === 'linear' || effectiveMode === 'jira' || jiraUrlIntent || sshReady)

  const {
    rows,
    loading,
    error,
    needsGitHubRemote,
    emptyHint,
    crossRepoPrompt,
    dismissCrossRepoPrompt
  } = useSmartWorkspaceSource({
    client,
    enabled: searchEnabled,
    mode: effectiveMode,
    query: composer.name,
    repoId,
    githubAvailable: availability.githubAvailable,
    gitlabAvailable: availability.gitlabAvailable,
    linearAvailable: availability.linearAvailable,
    jiraAvailable: availability.jiraAvailable,
    mrStateFilter,
    linearWorkspaceId,
    jiraSiteId,
    jiraSites,
    repos
  })

  function handleSelectRow(row: SourceRow): void {
    switch (row.kind) {
      case 'use-name':
        composer.setName(row.name)
        break
      case 'create-branch':
        composer.handleSmartCreateBranch(row.name)
        break
      case 'github':
        composer.handleSmartGitHubItemSelect(row.item)
        break
      case 'gitlab':
        composer.handleSmartGitLabItemSelect(row.item)
        break
      case 'branch':
        composer.handleSmartBranchSelect(row.refName, row.localBranchName)
        break
      case 'linear':
        composer.handleSmartLinearIssueSelect(row.issue)
        break
      case 'jira':
        composer.handleSmartJiraIssueSelect(row.issue)
        break
    }
    onClose()
  }

  async function handleAcceptCrossRepo(): Promise<void> {
    if (!client || !crossRepoPrompt) {
      return
    }
    const { link, matchingRepo } = crossRepoPrompt
    try {
      const item = await lookupGitHubItemByOwnerRepo(
        client,
        matchingRepo.id,
        link.slug,
        link.number,
        link.type
      )
      if (item) {
        onRepoChange(matchingRepo.id)
        composer.handleSmartGitHubItemSelect(item)
        onClose()
      }
    } catch {
      dismissCrossRepoPrompt()
    }
  }

  const showEmpty =
    !loading && !error && !needsGitHubRemote && effectiveMode !== 'text' && rows.length === 0

  const modeSegments = SMART_MODE_OPTIONS.filter((option: SmartModeOption) =>
    availableModes.includes(option.id)
  ).map((option) => ({ value: option.id, label: option.label }))

  const repoSearchBlocked =
    !sshReady &&
    effectiveMode !== 'text' &&
    effectiveMode !== 'linear' &&
    effectiveMode !== 'jira' &&
    !jiraUrlIntent
  const notice = repoSearchBlocked
    ? { tone: 'info' as const, message: 'Connect the repository to search sources.' }
    : needsGitHubRemote
      ? {
          tone: 'info' as const,
          message: 'This SSH repo needs a GitHub remote to list issues and PRs.'
        }
      : error
        ? { tone: 'error' as const, message: error }
        : null

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      dragContentToDismiss={false}
      contentScrollable={false}
      fillAvailable
      // Why: sit above the pinned create form so the outer content-sized sheet
      // stays underneath and is revealed at its original height on dismiss.
      zIndex={1100}
    >
      {/* Why: column with results flex:1 + dock flex-shrink:0 at the end.
          Fill sheet height + marginBottom place this column on the keyboard
          top; dock must stay a non-flex sibling so FlatList cannot clip it. */}
      <View style={styles.root}>
        <View style={styles.header}>
          <SheetHeader
            title={availability.textOnly ? 'Workspace name' : 'Start from'}
            trailing={{ label: 'Done', onPress: onClose }}
          />
        </View>

        <View style={styles.results}>
          {crossRepoPrompt ? (
            <View style={styles.banner}>
              <Banner
                message={`This item lives in ${crossRepoPrompt.link.slug.owner}/${crossRepoPrompt.link.slug.repo}.`}
                action={{
                  label: `Switch to ${crossRepoPrompt.matchingRepo.displayName}`,
                  onPress: () => void handleAcceptCrossRepo()
                }}
                onDismiss={dismissCrossRepoPrompt}
              />
            </View>
          ) : null}

          {notice ? (
            <View style={styles.banner}>
              <Banner tone={notice.tone} message={notice.message} />
            </View>
          ) : null}

          {effectiveMode === 'gitlab' ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={styles.filterScroll}
              contentContainerStyle={styles.filterRow}
            >
              {MR_STATE_FILTER_OPTIONS.map((option) => (
                <FilterChip
                  key={option.id}
                  label={option.label}
                  active={option.id === mrStateFilter}
                  onPress={() => setMrStateFilter(option.id)}
                />
              ))}
            </ScrollView>
          ) : null}

          <FlatList
            data={rows}
            keyExtractor={(row) => row.value}
            style={[styles.list, rows.length === 0 && styles.listEmpty]}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            nestedScrollEnabled
            ItemSeparatorComponent={SourceRowSeparator}
            ListFooterComponent={
              loading ? (
                <View style={styles.footerState} accessibilityRole="progressbar">
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                  <Text style={styles.footerText}>Searching…</Text>
                </View>
              ) : showEmpty ? (
                <View style={styles.footerState}>
                  <Text style={styles.footerText}>{emptyHint || 'No results found.'}</Text>
                </View>
              ) : rows.length === 0 && effectiveMode === 'text' ? (
                <View style={styles.footerState}>
                  <Text style={styles.footerText}>Type a workspace name below.</Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <SmartWorkspaceSourceRow row={item} onPress={() => handleSelectRow(item)} />
            )}
          />
        </View>

        <View style={styles.dock}>
          {modeSegments.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={styles.modeScroll}
              contentContainerStyle={styles.modeRow}
            >
              <MobileSegmentedControl
                segments={modeSegments}
                selected={effectiveMode}
                onSelect={setMode}
                testIDPrefix="smart-source-mode-"
              />
            </ScrollView>
          ) : null}

          <TextField
            ref={inputRef}
            value={composer.name}
            onChangeText={composer.setName}
            placeholder="Type a name or search a source"
            accessibilityLabel={availability.textOnly ? 'Workspace name' : 'Name or source'}
            autoCapitalize="none"
            autoCorrect={false}
            // Still request native auto-focus; the delayed ref focus is the reliable path.
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onClose}
            blurOnSubmit={false}
          />
        </View>
      </View>
    </BottomDrawer>
  )
}

function SourceRowSeparator() {
  return <View style={styles.separator} />
}
