import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  Pressable,
  Text,
  TextInput,
  View
} from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { SmartWorkspaceSourceRow as SourceRow } from '../../../src/shared/new-workspace/smart-workspace-source-results'
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
import { smartWorkspaceSourceDrawerStyles as styles } from './smart-workspace-source-drawer-styles'
import { SmartSourceModeIcon } from './SmartSourceModeIcon'
import { SmartWorkspaceSourceRow } from './SmartWorkspaceSourceRow'

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
  sshReady: boolean
  onRepoChange: (repoId: string) => void
  onClose: () => void
}

export function SmartWorkspaceSourceDrawer({
  visible,
  client,
  composer,
  availability,
  repoId,
  repos,
  linearWorkspaceId,
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

  // Linear searches without a repo; every other provider/branch search needs a
  // connected repo-backed target.
  const searchEnabled = visible && (effectiveMode === 'linear' || sshReady)

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
    mrStateFilter,
    linearWorkspaceId,
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

  const modeTabs = SMART_MODE_OPTIONS.filter((option: SmartModeOption) =>
    availableModes.includes(option.id)
  )

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
          <Text style={styles.title}>Name or &apos;Create From&apos;</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.results}>
          {crossRepoPrompt ? (
            <View style={styles.crossRepo}>
              <Text style={styles.crossRepoText}>
                This item lives in {crossRepoPrompt.link.slug.owner}/
                {crossRepoPrompt.link.slug.repo}.
              </Text>
              <View style={styles.crossRepoActions}>
                <Pressable style={styles.crossRepoDismiss} onPress={dismissCrossRepoPrompt}>
                  <Text style={styles.crossRepoDismissText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.crossRepoSwitch}
                  onPress={() => void handleAcceptCrossRepo()}
                >
                  <Text style={styles.crossRepoSwitchText}>
                    Switch to {crossRepoPrompt.matchingRepo.displayName}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {!sshReady && effectiveMode !== 'text' && effectiveMode !== 'linear' ? (
            <Text style={styles.notice}>Connect the repository to search sources.</Text>
          ) : needsGitHubRemote ? (
            <Text style={styles.notice}>
              This SSH repo needs a GitHub remote to list issues and PRs.
            </Text>
          ) : error ? (
            <Text style={styles.errorNotice}>{error}</Text>
          ) : null}

          <FlatList
            data={rows}
            keyExtractor={(row) => row.value}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            nestedScrollEnabled
            ListFooterComponent={
              loading ? (
                <View style={styles.loading}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              ) : showEmpty ? (
                <Text style={styles.empty}>{emptyHint || 'No results found.'}</Text>
              ) : rows.length === 0 && effectiveMode === 'text' ? (
                <Text style={styles.empty}>Type a workspace name in the field below.</Text>
              ) : null
            }
            renderItem={({ item }) => (
              <SmartWorkspaceSourceRow row={item} onPress={() => handleSelectRow(item)} />
            )}
          />
        </View>

        <View style={styles.dock}>
          {effectiveMode === 'gitlab' ? (
            <View style={styles.chipRow}>
              {MR_STATE_FILTER_OPTIONS.map((option) => {
                const selected = option.id === mrStateFilter
                return (
                  <Pressable
                    key={option.id}
                    style={[styles.chip, selected && styles.chipSelected]}
                    onPress={() => setMrStateFilter(option.id)}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          ) : null}

          <View style={styles.tabRow}>
            {modeTabs.map((option) => {
              const selected = option.id === effectiveMode
              const tint = selected ? colors.textPrimary : colors.textSecondary
              return (
                <Pressable
                  key={option.id}
                  style={[styles.tab, selected && styles.tabSelected]}
                  onPress={() => setMode(option.id)}
                >
                  <SmartSourceModeIcon icon={option.icon} color={tint} />
                  <Text style={[styles.tabText, selected && styles.tabTextSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          <TextInput
            ref={inputRef}
            style={styles.search}
            value={composer.name}
            onChangeText={composer.setName}
            placeholder="Type a name or search a source"
            placeholderTextColor={colors.textMuted}
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
