import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { CircleDot, GitBranch, GitPullRequest, ListTodo } from 'lucide-react-native'
import { isWorkspaceSourceQueryWithinLimit } from '../../../src/shared/workspace-source-query'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import type {
  NewWorkspaceSourceFilter,
  NewWorkspaceSourceRow,
  ResolvedNewWorkspaceSource,
  WorkspaceSourceAvailability
} from '../workspace-source/new-workspace-source-types'
import {
  NEW_WORKSPACE_SOURCE_RESULT_LIMIT,
  resolveWorkspaceSourcePr,
  searchWorkspaceSources
} from '../workspace-source/workspace-source-rpc'
import {
  resolveBranchWorkspaceSource,
  resolveGitHubWorkspaceSource,
  resolveLinearWorkspaceSource
} from '../workspace-source/workspace-source-selection'
import type { WorkspaceNameState } from '../workspace-source/workspace-source-name-state'
import { getAvailableWorkspaceSourceFilters } from '../workspace-source/workspace-source-availability'
import { BottomDrawer } from './BottomDrawer'
import { MobileSearchField } from './MobileSearchField'
import {
  workspaceSourceAccessibilityLabel,
  workspaceSourceFilterLabel,
  workspaceSourceSubtitle,
  workspaceSourceTitle
} from './new-workspace-source-drawer-presentation'

const SEARCH_DEBOUNCE_MS = 200
const VISIBLE_LOADING_DELAY_MS = 200
const SOURCE_LIST_HEIGHT = 250

type Props = {
  visible: boolean
  client: RpcClient | null
  repoId: string
  availability: WorkspaceSourceAvailability
  sshStateGeneration: number
  name: WorkspaceNameState
  worktreeBranches: readonly string[]
  onSelect: (source: ResolvedNewWorkspaceSource) => void
  onClose: () => void
  onHidden?: () => void
  onOpen: () => void
}

export function NewWorkspaceSourceDrawer({
  visible,
  client,
  repoId,
  availability,
  sshStateGeneration,
  name,
  worktreeBranches,
  onSelect,
  onClose,
  onHidden,
  onOpen
}: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<NewWorkspaceSourceFilter>('all')
  const [rows, setRows] = useState<NewWorkspaceSourceRow[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [showLoading, setShowLoading] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [selectionError, setSelectionError] = useState('')
  // Why: selection disables immediately, while visible progress stays delayed for fast hosts.
  const [selectionPending, setSelectionPending] = useState(false)
  const [resolvingKey, setResolvingKey] = useState<string | null>(null)
  const generationRef = useRef(0)
  const selectionEpochRef = useRef(0)
  const selectionInFlightRef = useRef(false)
  const filters = useMemo(() => getAvailableWorkspaceSourceFilters(availability), [availability])

  useEffect(() => {
    if (visible) {
      onOpen()
    }
  }, [onOpen, visible])

  useEffect(
    () => () => {
      generationRef.current += 1
      selectionEpochRef.current += 1
      selectionInFlightRef.current = false
    },
    []
  )

  useEffect(() => {
    if (!filters.includes(filter)) {
      setFilter('all')
    }
  }, [filter, filters])

  useEffect(() => {
    const generation = ++generationRef.current
    // Why: stale host work must not retain request-owned selection UI.
    selectionEpochRef.current += 1
    selectionInFlightRef.current = false
    setSelectionPending(false)
    setResolvingKey(null)
    setSelectionError('')
    // Why: rows belong to the query/filter/availability generation that loaded them;
    // retaining them during debounce would leave stale sources selectable.
    setRows([])
    setWarnings([])
    setErrors([])
    if (!visible || !client || !isWorkspaceSourceQueryWithinLimit(query)) {
      setLoading(false)
      setShowLoading(false)
      return
    }
    setLoading(true)
    setShowLoading(false)
    let requestTimer: ReturnType<typeof setTimeout> | null = null
    const loadingTimer = setTimeout(() => {
      if (generation === generationRef.current) {
        setShowLoading(true)
      }
    }, VISIBLE_LOADING_DELAY_MS)
    const run = () => {
      void searchWorkspaceSources({
        client,
        repoId,
        query,
        filter,
        availability
      })
        .then((result) => {
          if (generation !== generationRef.current) {
            return
          }
          setRows(result.rows)
          setWarnings(result.warnings)
          setErrors(result.errors)
        })
        .finally(() => {
          if (generation === generationRef.current) {
            setLoading(false)
            setShowLoading(false)
          }
        })
    }
    if (query.trim()) {
      requestTimer = setTimeout(run, SEARCH_DEBOUNCE_MS)
    } else {
      run()
    }
    return () => {
      clearTimeout(loadingTimer)
      if (requestTimer) {
        clearTimeout(requestTimer)
      }
    }
  }, [availability, client, filter, query, repoId, retryKey, sshStateGeneration, visible])

  const selectRow = useCallback(
    async (row: NewWorkspaceSourceRow): Promise<void> => {
      if (selectionInFlightRef.current) {
        return
      }
      selectionInFlightRef.current = true
      generationRef.current += 1
      const selectionEpoch = ++selectionEpochRef.current
      setSelectionPending(true)
      setSelectionError('')
      let spinnerTimer: ReturnType<typeof setTimeout> | null = null
      try {
        if (row.kind === 'github') {
          if (row.item.type === 'pr') {
            spinnerTimer = setTimeout(() => {
              if (selectionEpoch === selectionEpochRef.current) {
                setResolvingKey(row.key)
              }
            }, VISIBLE_LOADING_DELAY_MS)
            const startPoint = await resolveWorkspaceSourcePr({
              client: client!,
              repoId,
              item: row.item
            })
            if (selectionEpoch !== selectionEpochRef.current) {
              return
            }
            onSelect(resolveGitHubWorkspaceSource(row.item, startPoint))
          } else {
            onSelect(resolveGitHubWorkspaceSource(row.item))
          }
        } else if (row.kind === 'linear') {
          onSelect(resolveLinearWorkspaceSource(row.issue))
        } else {
          onSelect(
            resolveBranchWorkspaceSource({
              ...row,
              name,
              worktreeBranches
            })
          )
        }
      } catch (error) {
        if (selectionEpoch === selectionEpochRef.current) {
          setSelectionError(
            error instanceof Error ? error.message : 'Failed to resolve the selected source.'
          )
        }
      } finally {
        if (spinnerTimer) {
          clearTimeout(spinnerTimer)
        }
        // Why: a stale completion must not release guards owned by a newer tap.
        if (selectionEpoch === selectionEpochRef.current) {
          selectionInFlightRef.current = false
          setSelectionPending(false)
          setResolvingKey(null)
        }
      }
    },
    [client, name, onSelect, repoId, worktreeBranches]
  )

  const oversized = !isWorkspaceSourceQueryWithinLimit(query)
  const message = oversized
    ? 'Search must be 2 KB or less.'
    : selectionError || errors[0] || warnings[0] || ''
  const emptyCopy = query.trim() ? 'No results.' : 'No recent sources.'

  return (
    <BottomDrawer visible={visible} onClose={onClose} onHidden={onHidden} contentScrollable={false}>
      <View style={styles.header}>
        <Text style={styles.title}>Start from</Text>
        <Text style={styles.subtitle}>Choose an issue, pull request, or branch.</Text>
      </View>
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search sources"
        autoFocus
        focusKey={visible}
        accessibilityLabel="Search workspace sources"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
        keyboardShouldPersistTaps="handled"
      >
        {filters.map((item) => (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === item }}
            accessibilityLabel={`${workspaceSourceFilterLabel(item)} source filter`}
            style={[styles.filter, filter === item && styles.filterSelected]}
            onPress={() => setFilter(item)}
          >
            <Text style={[styles.filterText, filter === item && styles.filterTextSelected]}>
              {workspaceSourceFilterLabel(item)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.statusSlot}>
        {message ? (
          <View style={styles.statusRow}>
            <Text
              style={[
                styles.statusText,
                (oversized || errors.length > 0 || selectionError) && styles.errorText
              ]}
              numberOfLines={2}
            >
              {message}
            </Text>
            {!oversized && errors.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry source search"
                onPress={() => setRetryKey((value) => value + 1)}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <FlatList
        data={oversized ? [] : rows.slice(0, NEW_WORKSPACE_SOURCE_RESULT_LIMIT)}
        keyExtractor={(row) => row.key}
        style={styles.list}
        contentContainerStyle={rows.length === 0 ? styles.emptyList : undefined}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        nestedScrollEnabled
        ItemSeparatorComponent={SourceSeparator}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            {showLoading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : !loading && !oversized && !errors.length ? (
              <Text style={styles.emptyText}>{emptyCopy}</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={workspaceSourceAccessibilityLabel(item)}
            accessibilityState={{ disabled: selectionPending }}
            disabled={selectionPending}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => void selectRow(item)}
          >
            <SourceIcon row={item} />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {workspaceSourceTitle(item)}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {workspaceSourceSubtitle(item)}
              </Text>
            </View>
            <View style={styles.trailing}>
              {resolvingKey === item.key ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : null}
            </View>
          </Pressable>
        )}
      />
    </BottomDrawer>
  )
}

function SourceIcon({ row }: { row: NewWorkspaceSourceRow }) {
  const props = { size: 16, color: colors.textSecondary, strokeWidth: 2.1 }
  return row.kind === 'branch' ? (
    <GitBranch {...props} />
  ) : row.kind === 'linear' ? (
    <ListTodo {...props} />
  ) : row.item.type === 'pr' ? (
    <GitPullRequest {...props} />
  ) : (
    <CircleDot {...props} />
  )
}

function SourceSeparator() {
  return <View style={styles.separator} />
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.xs, marginBottom: spacing.md },
  title: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  filters: { gap: spacing.xs, paddingVertical: spacing.sm },
  filter: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  filterSelected: { backgroundColor: colors.bgRaised, borderColor: colors.textSecondary },
  filterText: { fontSize: 12, color: colors.textSecondary },
  filterTextSelected: { color: colors.textPrimary, fontWeight: '600' },
  statusSlot: { minHeight: 34, justifyContent: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  errorText: { color: colors.statusRed },
  retryText: { fontSize: 12, fontWeight: '600', color: colors.textPrimary, padding: spacing.xs },
  list: {
    flexGrow: 0,
    height: SOURCE_LIST_HEIGHT,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    overflow: 'hidden'
  },
  emptyList: { flexGrow: 1 },
  emptyState: {
    minHeight: SOURCE_LIST_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: { fontSize: typography.bodySize, color: colors.textSecondary },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: typography.bodySize, color: colors.textPrimary },
  rowSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  trailing: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
