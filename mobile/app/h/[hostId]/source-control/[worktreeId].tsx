import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SectionListRenderItem
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ChevronLeft,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  CloudUpload,
  FileText,
  GitBranch,
  GitPullRequest,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react-native'
import { useHostClient } from '../../../../src/transport/client-context'
import type { RpcClient } from '../../../../src/transport/rpc-client'
import type { RpcSuccess } from '../../../../src/transport/types'
import {
  ActionSheetModal,
  type ActionSheetAction
} from '../../../../src/components/ActionSheetModal'
import { ConfirmModal } from '../../../../src/components/ConfirmModal'
import { BottomDrawer } from '../../../../src/components/BottomDrawer'
import { triggerError, triggerSelection, triggerSuccess } from '../../../../src/platform/haptics'
import { colors, radii, spacing, typography } from '../../../../src/theme/mobile-theme'
import {
  buildMobileDiffLines,
  type MobileDiffLine
} from '../../../../src/session/mobile-diff-lines'
import {
  buildMobileBranchCompareSection,
  canOpenMobileBranchCompareDiff,
  formatMobileBranchCompareSummary,
  type MobileGitBranchChangeEntry,
  type MobileGitBranchCompareResult,
  type MobileGitBranchCompareSummary
} from '../../../../src/source-control/mobile-branch-compare'
import {
  MOBILE_GIT_STATUS_LABELS,
  buildMobileSourceControlSections,
  countStagedEntries,
  countUnstagedEntries,
  getStageablePaths,
  getUnstageablePaths,
  isMobileGitDiscardableEntry,
  isMobileGitStageableEntry,
  isMobileGitUnavailable,
  isMobileGitTransientRefreshError,
  type MobileGitFileStatus,
  type MobileGitStatusEntry,
  type MobileGitStatusResult,
  type MobileGitUpstreamStatus,
  type MobileSourceControlSection
} from '../../../../src/source-control/mobile-git-status'

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: MobileGitStatusResult }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

type LoadStatusOptions = {
  preserveReadyOnFailure?: boolean
  clearActionErrorOnSuccess?: boolean
  force?: boolean
}

type StatusLoadInFlight = {
  key: string
  client: unknown
  promise: Promise<boolean>
}

type GitRequestError = Error & { code?: string }
type GitCommitResult = { success: boolean; error?: string }

type MobileGitStatusEntryView = MobileGitStatusEntry & {
  canDiscard: boolean
  canOpen: boolean
  canStage: boolean
  discardActionId: string
  stageActionId: string
  unstageActionId: string
}

type MobileBranchCompareState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: MobileGitBranchCompareResult }
  | { kind: 'error'; message: string }

type MobileBranchEntryView = MobileGitBranchChangeEntry & {
  canOpen: boolean
}

type MobileBranchDiffPreviewState =
  | { kind: 'loading'; entry: MobileGitBranchChangeEntry }
  | {
      kind: 'ready'
      entry: MobileGitBranchChangeEntry
      summary: MobileGitBranchCompareSummary
      lines: MobileDiffLine[]
      truncated: boolean
    }
  | { kind: 'error'; entry: MobileGitBranchChangeEntry; message: string }

type RuntimeRepoSummary = {
  id: string
  worktreeBaseRef?: string | null
}

type RepoBaseRefDefaultResult = {
  defaultBaseRef: string | null
  remoteCount: number
}

type GitDiffTextResult = {
  kind: 'text'
  originalContent: string
  modifiedContent: string
}

const KEYBOARD_COMMIT_BAR_CLEARANCE = 10
const SELECTOR_RETRY_COUNT = 3
const SELECTOR_RETRY_DELAY_MS = 250

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRepoIdFromMobileWorktreeId(id: string): string {
  // Why: mobile cannot import desktop shared modules in its standalone tsc run,
  // but the runtime worktree id wire format is still `${repoId}::${path}`.
  const separatorIdx = id.indexOf('::')
  return separatorIdx === -1 ? id : id.slice(0, separatorIdx)
}

async function resolveMobileBranchCompareBaseRef(
  client: RpcClient,
  worktreeId: string
): Promise<string | null> {
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  if (!repoId) {
    return null
  }

  let repoBaseRef: string | null = null
  const repoResponse = await client.sendRequest('repo.list')
  if (repoResponse.ok) {
    const repos = ((repoResponse as RpcSuccess).result as { repos?: RuntimeRepoSummary[] }).repos
    const repo = repos?.find((candidate) => candidate.id === repoId)
    repoBaseRef = repo?.worktreeBaseRef?.trim() || null
  }

  if (repoBaseRef) {
    return repoBaseRef
  }

  const defaultResponse = await client.sendRequest('repo.baseRefDefault', { repo: `id:${repoId}` })
  if (!defaultResponse.ok) {
    if (isMobileGitUnavailable(defaultResponse.error?.code, defaultResponse.error?.message)) {
      return null
    }
    throw new Error(defaultResponse.error?.message || 'Unable to resolve branch base')
  }
  const result = (defaultResponse as RpcSuccess).result as RepoBaseRefDefaultResult
  return result.defaultBaseRef?.trim() || null
}

function getWorktreeLabel(name: string | undefined, worktreeId: string): string {
  if (name?.trim()) {
    return name.trim()
  }
  const pathPart = worktreeId.includes('::')
    ? worktreeId.slice(worktreeId.indexOf('::') + 2)
    : worktreeId
  const normalized = pathPart.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'Worktree'
}

function formatBranchLabel(branch: string | undefined, head: string | undefined): string {
  if (branch?.startsWith('refs/heads/')) {
    return branch.slice('refs/heads/'.length)
  }
  return branch || head?.slice(0, 7) || 'No branch'
}

function statusColor(status: MobileGitFileStatus): string {
  switch (status) {
    case 'added':
    case 'copied':
      return colors.statusGreen
    case 'deleted':
      return colors.statusRed
    case 'renamed':
      return colors.accentBlue
    case 'untracked':
      return colors.statusAmber
    case 'modified':
    default:
      return colors.textSecondary
  }
}

function formatBranchEntryMeta(entry: MobileGitBranchChangeEntry): string | null {
  const stats =
    entry.added !== undefined || entry.removed !== undefined
      ? `+${entry.added ?? 0} -${entry.removed ?? 0}`
      : null
  if (entry.oldPath) {
    return stats ? `from ${entry.oldPath}; ${stats}` : `from ${entry.oldPath}`
  }
  return stats
}

function diffLinePrefix(kind: MobileDiffLine['kind']): string {
  if (kind === 'add') {
    return '+'
  }
  if (kind === 'delete') {
    return '-'
  }
  return ' '
}

function diffLineNumber(line: MobileDiffLine): string {
  return String(line.newLineNumber ?? line.oldLineNumber ?? '')
}

export default function MobileSourceControlScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const origin = firstParam(params.origin)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { client, state: connState } = useHostClient(hostId)
  const [screenState, setScreenState] = useState<ScreenState>({ kind: 'loading' })
  const [branchCompareState, setBranchCompareState] = useState<MobileBranchCompareState>({
    kind: 'idle'
  })
  const [branchDiffPreview, setBranchDiffPreview] = useState<MobileBranchDiffPreviewState | null>(
    null
  )
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [discardTarget, setDiscardTarget] = useState<MobileGitStatusEntry | null>(null)
  const [showActionSheet, setShowActionSheet] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [keyboardLift, setKeyboardLift] = useState(0)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [openingBranchPath, setOpeningBranchPath] = useState<string | null>(null)
  const busyActionRef = useRef<string | null>(null)
  const currentStatusIdentityRef = useRef('')
  const currentBranchCompareIdentityRef = useRef('')
  const loadGenerationRef = useRef(0)
  const branchCompareGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const openingPathRef = useRef<string | null>(null)
  const openingBranchPathRef = useRef<string | null>(null)
  const statusLoadInFlightRef = useRef<StatusLoadInFlight | null>(null)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const statusIdentityKey = `${hostId}\0${worktreeId}`
  currentStatusIdentityRef.current = statusIdentityKey
  currentBranchCompareIdentityRef.current = statusIdentityKey

  const setMobileSourceControlRootRef = useCallback((node: View | null): void => {
    if (node !== null) {
      mountedRef.current = true
      return
    }
    // Why: source-control RPC loads can outlive the route; invalidate pending
    // writes when the screen detaches without a passive cleanup-only Effect.
    mountedRef.current = false
    loadGenerationRef.current += 1
    branchCompareGenerationRef.current += 1
  }, [])

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const onShow = Keyboard.addListener(showEvent, (event) => {
      const height = event.endCoordinates.height - (Platform.OS === 'ios' ? insets.bottom : 0)
      setKeyboardLift(Math.max(0, height))
    })
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboardLift(0))

    return () => {
      onShow.remove()
      onHide.remove()
    }
  }, [insets.bottom])

  const loadBranchCompare = useCallback(
    async (options?: { preserveReadyOnFailure?: boolean }) => {
      const loadKey = statusIdentityKey
      const generation = branchCompareGenerationRef.current + 1
      branchCompareGenerationRef.current = generation
      const isCurrentLoad = () =>
        mountedRef.current &&
        branchCompareGenerationRef.current === generation &&
        currentBranchCompareIdentityRef.current === loadKey

      if (!worktreeId || !client || connState !== 'connected') {
        if (isCurrentLoad()) {
          setBranchCompareState({ kind: 'idle' })
        }
        return false
      }

      setBranchCompareState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
      try {
        const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
        if (!isCurrentLoad()) {
          return false
        }
        if (!baseRef) {
          setBranchCompareState({ kind: 'idle' })
          return true
        }
        const response = await client.sendRequest('git.branchCompare', {
          worktree: `id:${worktreeId}`,
          baseRef
        })
        if (!isCurrentLoad()) {
          return false
        }
        if (!response.ok) {
          if (isMobileGitUnavailable(response.error?.code, response.error?.message)) {
            setBranchCompareState({ kind: 'idle' })
            return false
          }
          throw new Error(response.error?.message || 'Unable to load committed changes')
        }
        setBranchCompareState({
          kind: 'ready',
          result: (response as RpcSuccess).result as MobileGitBranchCompareResult
        })
        return true
      } catch (err) {
        if (!isCurrentLoad()) {
          return false
        }
        const message = err instanceof Error ? err.message : 'Unable to load committed changes'
        setBranchCompareState((prev) => {
          if (options?.preserveReadyOnFailure && prev.kind === 'ready') {
            return prev
          }
          return { kind: 'error', message }
        })
        return false
      }
    },
    [client, connState, statusIdentityKey, worktreeId]
  )

  const loadStatus = useCallback(
    async (options?: LoadStatusOptions) => {
      const loadKey = statusIdentityKey
      const inFlight = statusLoadInFlightRef.current
      if (inFlight && !options?.force && inFlight.key === loadKey && inFlight.client === client) {
        return await inFlight.promise
      }

      const loadPromise = (async () => {
        const generation = loadGenerationRef.current + 1
        loadGenerationRef.current = generation
        const isCurrentLoad = () =>
          mountedRef.current &&
          loadGenerationRef.current === generation &&
          currentStatusIdentityRef.current === loadKey
        if (!worktreeId) {
          if (isCurrentLoad()) {
            setScreenState({ kind: 'loading' })
          }
          return false
        }
        if (!client || connState !== 'connected') {
          if (isCurrentLoad()) {
            setScreenState({
              kind: 'error',
              message:
                connState === 'connected' ? 'Connecting to desktop...' : 'Waiting for desktop...'
            })
          }
          return false
        }
        if (!isCurrentLoad()) {
          return false
        }
        setScreenState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
        try {
          for (let attempt = 0; attempt <= SELECTOR_RETRY_COUNT; attempt += 1) {
            const response = await client.sendRequest('git.status', {
              worktree: `id:${worktreeId}`
            })
            if (!isCurrentLoad()) {
              return false
            }
            if (response.ok) {
              const result = (response as RpcSuccess).result as MobileGitStatusResult
              setScreenState({ kind: 'ready', status: result })
              void loadBranchCompare({ preserveReadyOnFailure: true })
              if (options?.clearActionErrorOnSuccess !== false) {
                setActionError(null)
              }
              return true
            }
            if (isMobileGitUnavailable(response.error?.code, response.error?.message)) {
              setScreenState({
                kind: 'unavailable',
                message: 'Update Orca desktop to use Source Control on mobile.'
              })
              return false
            }
            const shouldRetry =
              response.error?.code === 'selector_not_found' ||
              isMobileGitTransientRefreshError(response.error?.code, response.error?.message)
            if (shouldRetry && attempt < SELECTOR_RETRY_COUNT) {
              await wait(SELECTOR_RETRY_DELAY_MS)
              if (!isCurrentLoad()) {
                return false
              }
              continue
            }
            throw new Error(response.error?.message || 'Unable to load source control')
          }
        } catch (err) {
          if (!isCurrentLoad()) {
            return false
          }
          const message = err instanceof Error ? err.message : 'Unable to load source control'
          setScreenState((prev) => {
            // Why: git mutations can succeed while the immediate status refresh
            // races a desktop abort; keep the last good screen instead of flashing
            // a full-screen error that Retry fixes a moment later.
            if (options?.preserveReadyOnFailure && prev.kind === 'ready') {
              return prev
            }
            return { kind: 'error', message }
          })
          return false
        }
        return false
      })()

      statusLoadInFlightRef.current = { key: loadKey, client, promise: loadPromise }
      try {
        return await loadPromise
      } finally {
        if (statusLoadInFlightRef.current?.promise === loadPromise) {
          statusLoadInFlightRef.current = null
        }
      }
    },
    [client, connState, loadBranchCompare, statusIdentityKey, worktreeId]
  )

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const status = screenState.kind === 'ready' ? screenState.status : null
  const entries = status?.entries ?? []
  const derivedEntries = useMemo<MobileGitStatusEntryView[]>(
    () =>
      entries.map((entry) => ({
        ...entry,
        canDiscard: isMobileGitDiscardableEntry(entry),
        canOpen: entry.status !== 'deleted' && entry.conflictStatus !== 'unresolved',
        canStage: isMobileGitStageableEntry(entry),
        discardActionId: `discard:${entry.path}`,
        stageActionId: `stage:${entry.path}`,
        unstageActionId: `unstage:${entry.path}`
      })),
    [entries]
  )
  const sections = useMemo(() => buildMobileSourceControlSections(derivedEntries), [derivedEntries])
  const branchCompareResult = branchCompareState.kind === 'ready' ? branchCompareState.result : null
  const branchCompareSection = useMemo(
    () => buildMobileBranchCompareSection(branchCompareResult?.entries ?? []),
    [branchCompareResult]
  )
  const branchCompareSummaryText = branchCompareResult
    ? formatMobileBranchCompareSummary(branchCompareResult.summary)
    : null
  const branchCompareCanOpen = branchCompareResult
    ? canOpenMobileBranchCompareDiff(branchCompareResult.summary)
    : false
  const branchEntries = useMemo<MobileBranchEntryView[]>(
    () =>
      (branchCompareSection?.data ?? []).map((entry) => ({
        ...entry,
        canOpen: branchCompareCanOpen
      })),
    [branchCompareCanOpen, branchCompareSection]
  )
  const shouldShowBranchCompareSection =
    branchEntries.length > 0 ||
    branchCompareState.kind === 'loading' ||
    branchCompareState.kind === 'error' ||
    (branchCompareResult !== null && branchCompareResult.summary.status !== 'ready')
  const hasVisibleChanges = sections.length > 0 || shouldShowBranchCompareSection
  const stageablePaths = useMemo(() => getStageablePaths(entries), [entries])
  const unstageablePaths = useMemo(() => getUnstageablePaths(entries), [entries])
  const stagedCount = useMemo(() => countStagedEntries(entries), [entries])
  const unstagedCount = useMemo(() => countUnstagedEntries(entries), [entries])
  const branchLabel = formatBranchLabel(status?.branch, status?.head)
  const upstream = status?.upstreamStatus
  const upstreamKnown = upstream !== undefined
  const syncLabel =
    upstream && upstream.hasUpstream
      ? `${upstream.ahead} ahead, ${upstream.behind} behind`
      : upstream && !upstream.hasUpstream
        ? 'No upstream'
        : null

  const sendGitRequest = useCallback(
    async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await client.sendRequest(method, {
        worktree: `id:${worktreeId}`,
        ...params
      })
      if (!response.ok) {
        const error = new Error(
          response.error?.message || 'Source control action failed'
        ) as GitRequestError
        error.code = response.error?.code
        throw error
      }
      return (response as RpcSuccess).result as T
    },
    [client, connState, worktreeId]
  )

  const sendCommitRequest = useCallback(
    async (message: string): Promise<GitCommitResult> => {
      const result = await sendGitRequest<GitCommitResult>('git.commit', { message })
      if (!result || result.success !== true) {
        throw new Error(result?.error || 'Commit failed')
      }
      return result
    },
    [sendGitRequest]
  )

  const readUpstreamStatusForSync = useCallback(async (): Promise<MobileGitUpstreamStatus> => {
    try {
      return await sendGitRequest<MobileGitUpstreamStatus>('git.upstreamStatus')
    } catch (err) {
      const code = err instanceof Error ? (err as GitRequestError).code : undefined
      const message = err instanceof Error ? err.message : String(err)
      if (!isMobileGitUnavailable(code, message)) {
        throw err
      }
      const status = await sendGitRequest<MobileGitStatusResult>('git.status')
      if (!status.upstreamStatus) {
        throw new Error('Branch status unavailable')
      }
      return status.upstreamStatus
    }
  }, [sendGitRequest])

  const runGitSyncSteps = useCallback(async () => {
    await sendGitRequest<unknown>('git.fetch')
    await sendGitRequest<unknown>('git.pull')
    const nextUpstream = await readUpstreamStatusForSync()
    if (nextUpstream.ahead > 0) {
      await sendGitRequest<unknown>('git.push')
    }
  }, [readUpstreamStatusForSync, sendGitRequest])

  const runGitWorkflow = useCallback(
    async (
      actionId: string,
      runner: () => Promise<void>,
      options?: { clearCommitMessage?: boolean }
    ) => {
      if (busyActionRef.current) {
        return false
      }
      busyActionRef.current = actionId
      setBusyAction(actionId)
      setActionError(null)
      try {
        await runner()
        if (!mountedRef.current) {
          return false
        }
        if (options?.clearCommitMessage) {
          setCommitMessage('')
        }
        triggerSuccess()
        await loadStatus({ preserveReadyOnFailure: true, force: true })
        return true
      } catch (err) {
        if (!mountedRef.current) {
          return false
        }
        triggerError()
        setActionError(err instanceof Error ? err.message : 'Source control action failed')
        return false
      } finally {
        if (busyActionRef.current === actionId) {
          busyActionRef.current = null
          if (mountedRef.current) {
            setBusyAction(null)
          }
        }
      }
    },
    [loadStatus]
  )

  const runGitAction = useCallback(
    async (actionId: string, method: string, params: Record<string, unknown>) => {
      return await runGitWorkflow(actionId, async () => {
        await sendGitRequest<unknown>(method, params)
      })
    },
    [runGitWorkflow, sendGitRequest]
  )

  const runGitSequence = useCallback(
    async (
      actionId: string,
      steps: Array<{ method: string; params?: Record<string, unknown> }>,
      options?: { clearCommitMessage?: boolean }
    ) => {
      return await runGitWorkflow(
        actionId,
        async () => {
          for (const step of steps) {
            await sendGitRequest<unknown>(step.method, step.params)
          }
        },
        options
      )
    },
    [runGitWorkflow, sendGitRequest]
  )

  const runGitSync = useCallback(
    async (actionId: string) => await runGitWorkflow(actionId, runGitSyncSteps),
    [runGitSyncSteps, runGitWorkflow]
  )

  const stageAll = useCallback(async () => {
    const filePaths = stageablePaths
    if (filePaths.length === 0) {
      return
    }
    await runGitAction('stage-all', 'git.bulkStage', { filePaths })
  }, [runGitAction, stageablePaths])

  const unstageAll = useCallback(async () => {
    const filePaths = unstageablePaths
    if (filePaths.length === 0) {
      return
    }
    await runGitAction('unstage-all', 'git.bulkUnstage', { filePaths })
  }, [runGitAction, unstageablePaths])

  const commit = useCallback(async () => {
    const message = commitMessage.trim()
    if (!message) {
      return false
    }
    return await runGitWorkflow(
      'commit',
      async () => {
        await sendCommitRequest(message)
      },
      { clearCommitMessage: true }
    )
  }, [commitMessage, runGitWorkflow, sendCommitRequest])

  const runCommitFollowUps = useCallback(
    async (actionId: string, afterCommit: () => Promise<void>) => {
      const message = commitMessage.trim()
      if (!message) {
        return false
      }
      if (busyActionRef.current) {
        return false
      }
      busyActionRef.current = actionId
      setBusyAction(actionId)
      setActionError(null)
      let didCommit = false
      try {
        await sendCommitRequest(message)
        didCommit = true
        await afterCommit()
        if (!mountedRef.current) {
          return false
        }
        setCommitMessage('')
        triggerSuccess()
        await loadStatus({ preserveReadyOnFailure: true, force: true })
        return true
      } catch (err) {
        if (!mountedRef.current) {
          return false
        }
        triggerError()
        const message = err instanceof Error ? err.message : 'Source control action failed'
        if (didCommit) {
          setCommitMessage('')
          await loadStatus({
            preserveReadyOnFailure: true,
            clearActionErrorOnSuccess: false,
            force: true
          })
        }
        setActionError(message)
        return false
      } finally {
        if (busyActionRef.current === actionId) {
          busyActionRef.current = null
          if (mountedRef.current) {
            setBusyAction(null)
          }
        }
      }
    },
    [commitMessage, loadStatus, sendCommitRequest]
  )

  const runCommitSequence = useCallback(
    async (
      actionId: string,
      afterCommit: Array<{ method: string; params?: Record<string, unknown> }>
    ) => {
      return await runCommitFollowUps(actionId, async () => {
        for (const step of afterCommit) {
          await sendGitRequest<unknown>(step.method, step.params)
        }
      })
    },
    [runCommitFollowUps, sendGitRequest]
  )

  const runCommitSyncSequence = useCallback(async () => {
    return await runCommitFollowUps('commit-sync', runGitSyncSteps)
  }, [runCommitFollowUps, runGitSyncSteps])

  const runActionSheetCommit = useCallback(async () => {
    await commit()
    setShowActionSheet(false)
  }, [commit])

  const runActionSheetCommitSequence = useCallback(
    async (
      actionId: string,
      afterCommit: Array<{ method: string; params?: Record<string, unknown> }>
    ) => {
      await runCommitSequence(actionId, afterCommit)
      setShowActionSheet(false)
    },
    [runCommitSequence]
  )

  const runActionSheetCommitSync = useCallback(async () => {
    await runCommitSyncSequence()
    setShowActionSheet(false)
  }, [runCommitSyncSequence])

  const runActionSheetGitSequence = useCallback(
    async (
      actionId: string,
      steps: Array<{ method: string; params?: Record<string, unknown> }>
    ) => {
      await runGitSequence(actionId, steps)
      setShowActionSheet(false)
    },
    [runGitSequence]
  )

  const runActionSheetGitSync = useCallback(async () => {
    await runGitSync('sync')
    setShowActionSheet(false)
  }, [runGitSync])

  const openFile = useCallback(
    async (entry: MobileGitStatusEntry) => {
      if (entry.status === 'deleted' || entry.conflictStatus === 'unresolved') {
        return
      }
      if (openingPathRef.current || busyActionRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        if (!mountedRef.current) {
          return
        }
        setActionError('Waiting for desktop...')
        return
      }
      openingPathRef.current = entry.path
      setOpeningPath(entry.path)
      try {
        setActionError(null)
        let response = await client.sendRequest('files.openDiff', {
          worktree: `id:${worktreeId}`,
          relativePath: entry.path,
          staged: entry.area === 'staged'
        })
        if (!response.ok && isMobileGitUnavailable(response.error?.code, response.error?.message)) {
          response = await client.sendRequest('files.open', {
            worktree: `id:${worktreeId}`,
            relativePath: entry.path
          })
        }
        if (!response.ok) {
          throw new Error(response.error?.message || 'Unable to open diff')
        }
        if (!mountedRef.current) {
          return
        }
        triggerSelection()
        if (origin === 'session') {
          router.back()
          return
        }
        const params = new URLSearchParams()
        if (name) {
          params.set('name', name)
        }
        const query = params.toString()
        router.replace(
          `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${query ? `?${query}` : ''}`
        )
      } catch (err) {
        if (!mountedRef.current) {
          return
        }
        triggerError()
        setActionError(err instanceof Error ? err.message : 'Unable to open diff')
      } finally {
        if (openingPathRef.current === entry.path) {
          openingPathRef.current = null
          if (mountedRef.current) {
            setOpeningPath(null)
          }
        }
      }
    },
    [client, connState, hostId, name, origin, router, worktreeId]
  )

  const openBranchDiff = useCallback(
    async (entry: MobileGitBranchChangeEntry) => {
      if (openingBranchPathRef.current || openingPathRef.current || busyActionRef.current) {
        return
      }
      if (!client || connState !== 'connected') {
        if (!mountedRef.current) {
          return
        }
        setActionError('Waiting for desktop...')
        return
      }
      if (branchCompareState.kind !== 'ready') {
        return
      }
      const summary = branchCompareState.result.summary
      if (!canOpenMobileBranchCompareDiff(summary) || !summary.headOid || !summary.mergeBase) {
        return
      }

      openingBranchPathRef.current = entry.path
      setOpeningBranchPath(entry.path)
      setBranchDiffPreview({ kind: 'loading', entry })
      try {
        const response = await client.sendRequest('git.branchDiff', {
          worktree: `id:${worktreeId}`,
          filePath: entry.path,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
          compare: {
            baseRef: summary.baseRef,
            ...(summary.baseOid ? { baseOid: summary.baseOid } : {}),
            headOid: summary.headOid,
            mergeBase: summary.mergeBase
          }
        })
        if (!response.ok) {
          throw new Error(response.error?.message || 'Unable to load committed diff')
        }
        const result = (response as RpcSuccess).result as GitDiffTextResult | { kind: 'binary' }
        if (result.kind !== 'text') {
          throw new Error('Binary branch diff preview unavailable on mobile')
        }
        const diff = buildMobileDiffLines(result.originalContent, result.modifiedContent)
        if (!mountedRef.current) {
          return
        }
        setBranchDiffPreview({
          kind: 'ready',
          entry,
          summary,
          lines: diff.lines,
          truncated: diff.truncated
        })
        triggerSelection()
      } catch (err) {
        if (!mountedRef.current) {
          return
        }
        triggerError()
        setBranchDiffPreview({
          kind: 'error',
          entry,
          message: err instanceof Error ? err.message : 'Unable to load committed diff'
        })
      } finally {
        if (openingBranchPathRef.current === entry.path) {
          openingBranchPathRef.current = null
          if (mountedRef.current) {
            setOpeningBranchPath(null)
          }
        }
      }
    },
    [branchCompareState, client, connState, worktreeId]
  )

  const actionSheetActions = useMemo<ActionSheetAction[]>(() => {
    const hasMessage = commitMessage.trim().length > 0
    const hasStaged = stagedCount > 0
    const hasUpstream = upstream?.hasUpstream === true
    const ahead = upstream?.ahead ?? 0
    const behind = upstream?.behind ?? 0
    const busy = busyAction !== null || openingPath !== null || openingBranchPath !== null
    const commitHint = !hasStaged
      ? 'Stage at least one file'
      : !hasMessage
        ? 'Enter a commit message'
        : undefined
    const remoteHint = !upstreamKnown
      ? 'Checking branch status...'
      : hasUpstream
        ? undefined
        : 'Publish Branch first'
    const createPrHint = 'Pull requests are not available on mobile yet'

    return [
      {
        label: 'Commit',
        icon: Check,
        disabled: busy || !!commitHint,
        hint: commitHint,
        loading: busyAction === 'commit',
        skipAutoClose: true,
        onPress: () => void runActionSheetCommit()
      },
      {
        label: 'Commit & Push',
        icon: ArrowUp,
        disabled: busy || !!commitHint || !upstreamKnown || !hasUpstream,
        hint: commitHint ?? remoteHint,
        loading: busyAction === 'commit-push',
        skipAutoClose: true,
        onPress: () => void runActionSheetCommitSequence('commit-push', [{ method: 'git.push' }])
      },
      {
        label: 'Commit & Sync',
        icon: ArrowDownUp,
        disabled: busy || !!commitHint || !upstreamKnown || !hasUpstream || behind === 0,
        hint:
          commitHint ??
          (!upstreamKnown || !hasUpstream
            ? remoteHint
            : behind === 0
              ? 'Nothing to pull'
              : undefined),
        loading: busyAction === 'commit-sync',
        skipAutoClose: true,
        onPress: () => void runActionSheetCommitSync()
      },
      {
        label: ahead > 0 ? `Push (${ahead})` : 'Push',
        icon: ArrowUp,
        disabled: busy || !upstreamKnown || !hasUpstream || ahead === 0,
        hint: !hasUpstream ? remoteHint : ahead === 0 ? 'Nothing to push' : undefined,
        loading: busyAction === 'push',
        skipAutoClose: true,
        onPress: () => void runActionSheetGitSequence('push', [{ method: 'git.push' }])
      },
      {
        label: 'Create PR',
        icon: GitPullRequest,
        disabled: true,
        hint: createPrHint,
        onPress: () => {}
      },
      {
        label: 'Push & Create PR',
        icon: GitPullRequest,
        disabled: true,
        hint: createPrHint,
        onPress: () => {}
      },
      {
        label: behind > 0 ? `Pull (${behind})` : 'Pull',
        icon: ArrowDown,
        disabled: busy || !upstreamKnown || !hasUpstream || behind === 0,
        hint: !hasUpstream ? remoteHint : behind === 0 ? 'Nothing to pull' : undefined,
        loading: busyAction === 'pull',
        skipAutoClose: true,
        onPress: () => void runActionSheetGitSequence('pull', [{ method: 'git.pull' }])
      },
      {
        label: ahead > 0 || behind > 0 ? `Sync (↓${behind} ↑${ahead})` : 'Sync',
        icon: ArrowDownUp,
        disabled: busy || !upstreamKnown || !hasUpstream || (ahead === 0 && behind === 0),
        hint:
          !upstreamKnown || !hasUpstream
            ? remoteHint
            : ahead === 0 && behind === 0
              ? 'Branch is up to date'
              : undefined,
        loading: busyAction === 'sync',
        skipAutoClose: true,
        onPress: () => void runActionSheetGitSync()
      },
      {
        label: 'Fetch',
        icon: RefreshCw,
        disabled: busy,
        loading: busyAction === 'fetch',
        skipAutoClose: true,
        onPress: () => void runActionSheetGitSequence('fetch', [{ method: 'git.fetch' }])
      },
      {
        label: 'Publish Branch',
        icon: CloudUpload,
        disabled: busy || !upstreamKnown || hasUpstream,
        hint: !upstreamKnown
          ? 'Checking branch status...'
          : hasUpstream
            ? 'Branch is already published'
            : undefined,
        loading: busyAction === 'publish',
        skipAutoClose: true,
        onPress: () =>
          void runActionSheetGitSequence('publish', [
            { method: 'git.push', params: { publish: true } }
          ])
      }
    ]
  }, [
    busyAction,
    commitMessage,
    openingBranchPath,
    openingPath,
    runActionSheetCommit,
    runActionSheetCommitSequence,
    runActionSheetCommitSync,
    runActionSheetGitSequence,
    runActionSheetGitSync,
    stagedCount,
    upstream,
    upstreamKnown
  ])

  const renderItem = useCallback<
    SectionListRenderItem<
      MobileGitStatusEntryView,
      MobileSourceControlSection<MobileGitStatusEntryView>
    >
  >(
    ({ item }) => {
      const rowBusy =
        busyAction === item.stageActionId ||
        busyAction === item.unstageActionId ||
        busyAction === item.discardActionId ||
        openingPath === item.path
      const rowDisabled =
        !item.canOpen || busyAction !== null || openingPath !== null || openingBranchPath !== null
      return (
        <Pressable
          style={({ pressed }) => [
            styles.fileRow,
            pressed && item.canOpen && styles.fileRowPressed,
            rowDisabled && styles.fileRowDisabled,
            !item.canOpen && styles.fileRowUnavailable
          ]}
          onPress={() => void openFile(item)}
          disabled={rowDisabled}
          accessibilityLabel={`Open changed file ${item.path}`}
        >
          <View style={styles.statusBadge}>
            <Text style={[styles.statusBadgeText, { color: statusColor(item.status) }]}>
              {MOBILE_GIT_STATUS_LABELS[item.status]}
            </Text>
          </View>
          <FileText
            size={16}
            color={item.canOpen ? colors.textSecondary : colors.textMuted}
            strokeWidth={2.1}
          />
          <View style={styles.fileTextBlock}>
            <Text
              style={[styles.filePath, !item.canOpen && styles.filePathDisabled]}
              numberOfLines={1}
            >
              {item.path}
            </Text>
            {item.oldPath ? (
              <Text style={styles.fileMeta} numberOfLines={1}>
                from {item.oldPath}
              </Text>
            ) : item.conflictStatus === 'unresolved' ? (
              <Text style={styles.fileMeta} numberOfLines={1}>
                Unresolved conflict
              </Text>
            ) : null}
          </View>
          {rowBusy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : item.area === 'staged' ? (
            <Pressable
              style={({ pressed }) => [
                styles.iconButton,
                (busyAction !== null || openingPath !== null || openingBranchPath !== null) &&
                  styles.iconButtonDisabled,
                pressed && styles.iconButtonPressed
              ]}
              disabled={busyAction !== null || openingPath !== null || openingBranchPath !== null}
              onPress={() =>
                void runGitAction(item.unstageActionId, 'git.unstage', { filePath: item.path })
              }
              hitSlop={8}
              accessibilityLabel={`Unstage ${item.path}`}
            >
              <Minus size={16} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
          ) : item.canStage || item.canDiscard ? (
            <View style={styles.rowActions}>
              {item.canStage ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.iconButton,
                    (busyAction !== null || openingPath !== null || openingBranchPath !== null) &&
                      styles.iconButtonDisabled,
                    pressed && styles.iconButtonPressed
                  ]}
                  disabled={
                    busyAction !== null || openingPath !== null || openingBranchPath !== null
                  }
                  onPress={() =>
                    void runGitAction(item.stageActionId, 'git.stage', { filePath: item.path })
                  }
                  hitSlop={8}
                  accessibilityLabel={`Stage ${item.path}`}
                >
                  <Plus size={16} color={colors.textSecondary} strokeWidth={2.2} />
                </Pressable>
              ) : null}
              {item.canDiscard ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.iconButton,
                    (busyAction !== null || openingPath !== null || openingBranchPath !== null) &&
                      styles.iconButtonDisabled,
                    pressed && styles.iconButtonPressed
                  ]}
                  disabled={
                    busyAction !== null || openingPath !== null || openingBranchPath !== null
                  }
                  onPress={() => setDiscardTarget(item)}
                  hitSlop={8}
                  accessibilityLabel={`Discard ${item.path}`}
                >
                  <Trash2 size={16} color={colors.statusRed} strokeWidth={2.1} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </Pressable>
      )
    },
    [busyAction, openFile, openingBranchPath, openingPath, runGitAction]
  )

  const keyExtractor = useCallback(
    (item: MobileGitStatusEntryView) => `${item.area}:${item.path}:${item.oldPath ?? ''}`,
    []
  )

  const renderSectionHeader = useCallback(
    ({ section }: { section: MobileSourceControlSection<MobileGitStatusEntryView> }) => (
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        <Text style={styles.sectionCount}>{section.data.length}</Text>
      </View>
    ),
    []
  )

  const renderBranchCompareFooter = useCallback(() => {
    if (!shouldShowBranchCompareSection) {
      return null
    }

    return (
      <View style={styles.branchCompareBlock}>
        <View style={styles.sectionHeader}>
          <View style={styles.branchSectionTitleBlock}>
            <Text style={styles.sectionTitle}>Committed on Branch</Text>
            {branchCompareSummaryText ? (
              <Text style={styles.branchSectionSubtitle} numberOfLines={1}>
                {branchCompareSummaryText}
              </Text>
            ) : null}
          </View>
          <Text style={styles.sectionCount}>{branchEntries.length}</Text>
        </View>
        {branchCompareState.kind === 'loading' ? (
          <View style={styles.branchStateRow}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.branchStateText}>Loading committed changes...</Text>
          </View>
        ) : branchCompareState.kind === 'error' ? (
          <View style={styles.branchStateRow}>
            <Text style={styles.branchStateText}>{branchCompareState.message}</Text>
          </View>
        ) : branchCompareResult && branchCompareResult.summary.status !== 'ready' ? (
          <View style={styles.branchStateRow}>
            <Text style={styles.branchStateText}>
              {branchCompareResult.summary.errorMessage ?? 'Committed changes unavailable.'}
            </Text>
          </View>
        ) : (
          branchEntries.map((entry) => {
            const rowBusy = openingBranchPath === entry.path
            const rowDisabled =
              !entry.canOpen ||
              busyAction !== null ||
              openingPath !== null ||
              openingBranchPath !== null
            const meta = formatBranchEntryMeta(entry)
            return (
              <Pressable
                key={`${entry.path}:${entry.oldPath ?? ''}`}
                style={({ pressed }) => [
                  styles.fileRow,
                  pressed && entry.canOpen && styles.fileRowPressed,
                  rowDisabled && styles.fileRowDisabled,
                  !entry.canOpen && styles.fileRowUnavailable
                ]}
                onPress={() => void openBranchDiff(entry)}
                disabled={rowDisabled}
                accessibilityLabel={`Open committed change ${entry.path}`}
              >
                <View style={styles.statusBadge}>
                  <Text style={[styles.statusBadgeText, { color: statusColor(entry.status) }]}>
                    {MOBILE_GIT_STATUS_LABELS[entry.status]}
                  </Text>
                </View>
                <FileText
                  size={16}
                  color={entry.canOpen ? colors.textSecondary : colors.textMuted}
                  strokeWidth={2.1}
                />
                <View style={styles.fileTextBlock}>
                  <Text
                    style={[styles.filePath, !entry.canOpen && styles.filePathDisabled]}
                    numberOfLines={1}
                  >
                    {entry.path}
                  </Text>
                  {meta ? (
                    <Text style={styles.fileMeta} numberOfLines={1}>
                      {meta}
                    </Text>
                  ) : null}
                </View>
                {rowBusy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
              </Pressable>
            )
          })
        )}
      </View>
    )
  }, [
    branchCompareResult,
    branchCompareState,
    branchCompareSummaryText,
    branchEntries,
    busyAction,
    openBranchDiff,
    openingBranchPath,
    openingPath,
    shouldShowBranchCompareSection
  ])

  const renderBranchDiffPreview = useCallback(() => {
    if (!branchDiffPreview) {
      return null
    }
    const entry = branchDiffPreview.entry
    return (
      <BottomDrawer
        visible={branchDiffPreview !== null}
        onClose={() => setBranchDiffPreview(null)}
        dragContentToDismiss={false}
        zIndex={1100}
      >
        <View style={styles.diffDrawerHeader}>
          <View style={styles.diffDrawerTitleBlock}>
            <Text style={styles.diffDrawerTitle} numberOfLines={1}>
              {entry.path}
            </Text>
            <Text style={styles.diffDrawerMeta} numberOfLines={1}>
              {branchDiffPreview.kind === 'ready'
                ? `${branchDiffPreview.summary.baseRef}..HEAD`
                : 'Committed on branch'}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.diffCloseButton, pressed && styles.iconButtonPressed]}
            onPress={() => setBranchDiffPreview(null)}
            hitSlop={8}
            accessibilityLabel="Close committed diff preview"
          >
            <X size={18} color={colors.textSecondary} strokeWidth={2.1} />
          </Pressable>
        </View>

        {branchDiffPreview.kind === 'loading' ? (
          <View style={styles.diffState}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : branchDiffPreview.kind === 'error' ? (
          <View style={styles.diffState}>
            <Text style={styles.stateTitle}>Unable to Load Diff</Text>
            <Text style={styles.stateText}>{branchDiffPreview.message}</Text>
          </View>
        ) : (
          <View style={styles.diffLines}>
            {branchDiffPreview.truncated ? (
              <Text style={styles.diffTruncatedText}>Diff truncated for mobile preview.</Text>
            ) : null}
            {branchDiffPreview.lines.map((line, index) => (
              <View
                key={`${index}:${line.kind}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}`}
                style={[
                  styles.diffLine,
                  line.kind === 'add' && styles.diffLineAdd,
                  line.kind === 'delete' && styles.diffLineDelete
                ]}
              >
                <Text style={styles.diffLineNumber}>{diffLineNumber(line)}</Text>
                <Text style={styles.diffLinePrefix}>{diffLinePrefix(line.kind)}</Text>
                <Text style={styles.diffLineText}>{line.text || ' '}</Text>
              </View>
            ))}
          </View>
        )}
      </BottomDrawer>
    )
  }, [branchDiffPreview])

  return (
    <View ref={setMobileSourceControlRootRef} style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityLabel="Back to session"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              Source Control
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {worktreeLabel}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.refreshButton,
              (busyAction !== null || openingPath !== null || openingBranchPath !== null) &&
                styles.refreshButtonDisabled,
              pressed && styles.refreshButtonPressed
            ]}
            onPress={() => void loadStatus()}
            disabled={busyAction !== null || openingPath !== null || openingBranchPath !== null}
            hitSlop={8}
            accessibilityLabel="Refresh source control"
          >
            <RefreshCw size={18} color={colors.textSecondary} strokeWidth={2.1} />
          </Pressable>
        </View>
      </SafeAreaView>

      {screenState.kind === 'loading' ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : screenState.kind === 'error' || screenState.kind === 'unavailable' ? (
        <View style={styles.state}>
          <Text style={styles.stateTitle}>
            {screenState.kind === 'unavailable' ? 'Source Control Unavailable' : 'Unable to Load'}
          </Text>
          <Text style={styles.stateText}>{screenState.message}</Text>
          {screenState.kind === 'error' ? (
            <Pressable style={styles.retryButton} onPress={() => void loadStatus()}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <View style={styles.branchLine}>
                <GitBranch size={15} color={colors.textSecondary} strokeWidth={2.1} />
                <Text style={styles.branchText} numberOfLines={1}>
                  {branchLabel}
                </Text>
              </View>
              {syncLabel ? <Text style={styles.syncText}>{syncLabel}</Text> : null}
            </View>
            <View style={styles.countRow}>
              <Text style={styles.countText}>{unstagedCount} changed</Text>
              <Text style={styles.countText}>{stagedCount} staged</Text>
              {branchEntries.length > 0 ? (
                <Text style={styles.countText}>{branchEntries.length} on branch</Text>
              ) : null}
              {status && status.conflictOperation !== 'unknown' ? (
                <Text style={styles.conflictText}>{status.conflictOperation}</Text>
              ) : null}
            </View>
            {actionError ? (
              <View style={styles.actionError}>
                <Text style={styles.actionErrorText} numberOfLines={2}>
                  {actionError}
                </Text>
              </View>
            ) : null}
            <View style={styles.bulkRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.bulkButton,
                  (stageablePaths.length === 0 ||
                    busyAction !== null ||
                    openingPath !== null ||
                    openingBranchPath !== null) &&
                    styles.bulkButtonDisabled,
                  pressed && styles.bulkButtonPressed
                ]}
                onPress={() => void stageAll()}
                disabled={
                  busyAction !== null ||
                  openingPath !== null ||
                  openingBranchPath !== null ||
                  stageablePaths.length === 0
                }
              >
                {busyAction === 'stage-all' ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Plus size={15} color={colors.textPrimary} strokeWidth={2.2} />
                )}
                <Text style={styles.bulkButtonText}>Stage All</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.bulkButton,
                  (unstageablePaths.length === 0 ||
                    busyAction !== null ||
                    openingPath !== null ||
                    openingBranchPath !== null) &&
                    styles.bulkButtonDisabled,
                  pressed && styles.bulkButtonPressed
                ]}
                onPress={() => void unstageAll()}
                disabled={
                  busyAction !== null ||
                  openingPath !== null ||
                  openingBranchPath !== null ||
                  unstageablePaths.length === 0
                }
              >
                {busyAction === 'unstage-all' ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <Minus size={15} color={colors.textPrimary} strokeWidth={2.2} />
                )}
                <Text style={styles.bulkButtonText}>Unstage All</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.bulkMenuButton,
                  pressed && styles.bulkButtonPressed,
                  (busyAction !== null || openingPath !== null || openingBranchPath !== null) &&
                    styles.bulkButtonDisabled
                ]}
                onPress={() => setShowActionSheet(true)}
                disabled={busyAction !== null || openingPath !== null || openingBranchPath !== null}
                hitSlop={8}
                accessibilityLabel="Open source control actions"
              >
                <MoreHorizontal size={18} color={colors.textPrimary} strokeWidth={2.1} />
              </Pressable>
            </View>
          </View>

          {!hasVisibleChanges ? (
            <View style={styles.state}>
              <Text style={styles.stateTitle}>No Changes</Text>
              <Text style={styles.stateText}>Working tree is clean.</Text>
            </View>
          ) : (
            <SectionList
              sections={sections}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              renderSectionHeader={renderSectionHeader}
              ListFooterComponent={renderBranchCompareFooter}
              stickySectionHeadersEnabled={false}
              contentContainerStyle={styles.listContent}
            />
          )}

          <View
            style={[
              styles.commitBar,
              {
                bottom:
                  keyboardLift > 0 ? keyboardLift + KEYBOARD_COMMIT_BAR_CLEARANCE : keyboardLift,
                paddingBottom: keyboardLift > 0 ? spacing.md : spacing.md + insets.bottom
              }
            ]}
          >
            <View style={styles.commitRow}>
              {stagedCount === 0 ? (
                <View
                  style={[styles.commitInput, styles.commitInputDisabled]}
                  accessibilityRole="text"
                  accessibilityState={{ disabled: true }}
                  accessibilityLabel="Commit message disabled. No staged files."
                >
                  <Text style={styles.commitInputDisabledText}>No staged files</Text>
                </View>
              ) : (
                <TextInput
                  style={styles.commitInput}
                  value={commitMessage}
                  onChangeText={setCommitMessage}
                  placeholder="Commit message"
                  placeholderTextColor={colors.textMuted}
                  editable={
                    busyAction === null && openingPath === null && openingBranchPath === null
                  }
                  returnKeyType="done"
                  onSubmitEditing={() => void commit()}
                />
              )}
              <Pressable
                style={({ pressed }) => [
                  styles.commitButton,
                  (!commitMessage.trim() ||
                    stagedCount === 0 ||
                    busyAction !== null ||
                    openingPath !== null ||
                    openingBranchPath !== null) &&
                    styles.commitButtonDisabled,
                  pressed && styles.commitButtonPressed
                ]}
                onPress={() => void commit()}
                disabled={
                  !commitMessage.trim() ||
                  stagedCount === 0 ||
                  busyAction !== null ||
                  openingPath !== null ||
                  openingBranchPath !== null
                }
              >
                {busyAction === 'commit' ? (
                  <ActivityIndicator size="small" color={colors.bgBase} />
                ) : (
                  <Text style={styles.commitButtonText}>Commit</Text>
                )}
              </Pressable>
            </View>
          </View>
        </>
      )}

      {renderBranchDiffPreview()}

      <ActionSheetModal
        visible={showActionSheet}
        title="Source Control"
        message={branchLabel}
        actions={actionSheetActions}
        onClose={() => setShowActionSheet(false)}
      />

      <ConfirmModal
        visible={discardTarget !== null}
        title="Discard Change"
        message={
          discardTarget
            ? `Discard changes to "${discardTarget.path}"? This cannot be undone.`
            : undefined
        }
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          if (discardTarget) {
            void runGitAction(`discard:${discardTarget.path}`, 'git.discard', {
              filePath: discardTarget.path
            })
          }
        }}
        onCancel={() => setDiscardTarget(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700'
  },
  meta: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  refreshButton: {
    width: 36,
    height: 36,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs
  },
  refreshButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  refreshButtonDisabled: {
    opacity: 0.45
  },
  summaryCard: {
    margin: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  branchLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  branchText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  syncText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  countRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm
  },
  countText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  conflictText: {
    color: colors.statusAmber,
    fontSize: typography.metaSize,
    textTransform: 'capitalize'
  },
  actionError: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed
  },
  actionErrorText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  bulkRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  bulkButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs
  },
  bulkMenuButton: {
    width: 42,
    minHeight: 36,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bulkButtonDisabled: {
    opacity: 0.45
  },
  bulkButtonPressed: {
    opacity: 0.75
  },
  bulkButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 136
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  sectionCount: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  branchCompareBlock: {
    paddingBottom: spacing.sm
  },
  branchSectionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  branchSectionSubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  branchStateRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  branchStateText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  fileRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  fileRowPressed: {
    backgroundColor: colors.bgPanel
  },
  fileRowDisabled: {
    opacity: 0.78
  },
  fileRowUnavailable: {
    opacity: 0.72
  },
  statusBadge: {
    width: 24,
    alignItems: 'center'
  },
  statusBadgeText: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  fileTextBlock: {
    flex: 1,
    minWidth: 0
  },
  filePath: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  filePathDisabled: {
    color: colors.textSecondary
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  iconButtonDisabled: {
    opacity: 0.45
  },
  commitBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: spacing.xs,
    padding: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  commitRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  commitInput: {
    flex: 1,
    minHeight: 42,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: typography.bodySize
  },
  commitInputDisabled: {
    backgroundColor: colors.bgPanel,
    borderColor: colors.borderSubtle,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center'
  },
  commitInputDisabledText: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  commitButton: {
    minWidth: 88,
    minHeight: 42,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md
  },
  commitButtonDisabled: {
    opacity: 0.45
  },
  commitButtonPressed: {
    opacity: 0.75
  },
  commitButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  stateTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.xs
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    textAlign: 'center'
  },
  retryButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  diffDrawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  diffDrawerTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  diffDrawerTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  diffDrawerMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  diffCloseButton: {
    width: 34,
    height: 34,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  diffState: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg
  },
  diffLines: {
    paddingTop: spacing.md,
    paddingBottom: spacing.lg
  },
  diffTruncatedText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginBottom: spacing.sm
  },
  diffLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingVertical: 2,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.row
  },
  diffLineAdd: {
    backgroundColor: colors.diffAddedBg
  },
  diffLineDelete: {
    backgroundColor: colors.diffDeletedBg
  },
  diffLineNumber: {
    width: 40,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    textAlign: 'right'
  },
  diffLinePrefix: {
    width: 12,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  diffLineText: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 17
  }
})
