import { useState, useEffect, useMemo, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Keyboard
} from 'react-native'
import { ChevronDown, ChevronUp } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { BottomDrawerModalHost } from './bottom-drawer-modal-host'
import { useNewWorktreeDrawerNavigation } from './use-new-worktree-drawer-navigation'
import { PickerListDrawer } from './PickerListDrawer'
import { MobileAgentIcon } from './MobileAgentIcon'
import { getSuggestedCreatureName } from './worktree-name-suggestion'
import { deriveWorkspaceSshGate, workspaceSshStatusLabel } from '../tasks/workspace-ssh-gate'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  persistSetupHookTrustApproval,
  wasSetupHookPreviouslyApproved,
  type SetupHookTrust
} from '../tasks/setup-hook-trust'
import {
  isMobileTuiAgent,
  isMobileTuiAgentEnabled,
  MOBILE_TUI_AGENT_LAUNCH_COMMANDS
} from '../tasks/mobile-tui-agents'
import type { PersistedTrustedOrcaHooks, TuiAgent } from '../../../src/shared/types'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import {
  NEW_WORKTREE_AGENT_OPTIONS as AGENT_OPTIONS,
  NEW_WORKTREE_BLANK_AGENT as BLANK_TERMINAL,
  pickPreferredNewWorktreeAgent,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption as AgentOption
} from './new-worktree-agent-selection'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from '../worktree/new-workspace-dialog-repo-selection'
import { createBlankWorkspace } from '../tasks/blank-workspace-create'
import { createWorkspaceFromComposerSource } from '../tasks/source-workspace-create'
import { useNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../tasks/mobile-task-providers'
import { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import type { SmartModeAvailabilityInput } from '../tasks/mobile-smart-source-modes'
import { deriveRepoSlug, type PasteRepoCandidate } from '../tasks/smart-source-paste-intent'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../src/shared/new-workspace/workspace-source'
import { getComposerRepoWorktreeBranches } from '../../../src/shared/composer-branch-selection'
import { SmartWorkspaceSourceField } from './SmartWorkspaceSourceField'
import { SmartWorkspaceSourceDrawer } from './SmartWorkspaceSourceDrawer'
import { SmartWorkspaceAdvancedFields } from './SmartWorkspaceAdvancedFields'
import { SetupHookTrustDrawer, type SetupTrustPrompt } from './SetupHookTrustDrawer'

type Repo = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  connectionId?: string | null
  kind?: 'git' | 'folder'
  upstream?: { owner: string; repo: string } | null
  gitRemoteIdentity?: { remoteUrl?: string; canonicalKey?: string } | null
}

type SetupDecision = 'inherit' | 'run' | 'skip'
type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
type RuntimeSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
  agentCmdOverrides?: Record<string, string>
}

type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: SetupHookTrust
}

type SetupHookDetails = {
  repoId: string
  command: string | null
  source: string | null
  trust: SetupHookTrust | null
  runPolicy: SetupRunPolicy
}

type DetectedAgentIdsState = {
  connectionId: string | null
  ids: Set<string>
}

type CreateOptions = {
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  approvedSetupContentHash?: string
}

function repoColor(name: string): string {
  const palette = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return palette[Math.abs(hash) % palette.length]!
}

function repoBadgeColor(repo: Repo | null): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? 'repository')
}

// ── Main modal ──────────────────────────────────────────────────────

type Props = {
  visible: boolean
  client: RpcClient | null
  hostId?: string
  // Why: existing worktree paths from the host so we can pick a unique
  // marine-creature default when the user leaves the name blank, matching
  // the desktop UI's behavior. The "already exists locally" collision is
  // on the on-disk directory basename, so paths (not displayNames) are
  // what the suggestion logic must dedupe against.
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  onCreated: (worktreeId: string, name: string) => void
  onClose: () => void
}

export function NewWorktreeModal({
  visible,
  client,
  hostId,
  existingWorktreePaths,
  existingWorktrees,
  onCreated,
  onClose
}: Props) {
  const openEpochRef = useRef(0)
  const wasVisibleRef = useRef(false)
  const clientEpochRef = useRef({ client, epoch: 0 })

  // Why: each drawer opening is a fresh form session; remounting resets local
  // form state before paint instead of clearing it in a visible-prop Effect.
  if (visible && !wasVisibleRef.current) {
    openEpochRef.current += 1
  }
  wasVisibleRef.current = visible
  if (clientEpochRef.current.client !== client) {
    clientEpochRef.current = { client, epoch: clientEpochRef.current.epoch + 1 }
  }

  return (
    <NewWorktreeModalContent
      key={`${openEpochRef.current}:${clientEpochRef.current.epoch}`}
      visible={visible}
      client={client}
      hostId={hostId}
      existingWorktreePaths={existingWorktreePaths}
      existingWorktrees={existingWorktrees}
      onCreated={onCreated}
      onClose={onClose}
    />
  )
}

function NewWorktreeModalContent({
  visible,
  client,
  hostId,
  existingWorktreePaths,
  existingWorktrees,
  onCreated,
  onClose
}: Props) {
  const [initialRepos] = useState(() => (hostId ? (getCachedRepos(hostId) as Repo[] | null) : null))
  const [repos, setRepos] = useState<Repo[]>(initialRepos ?? [])
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const { drawerView, formSheetVisible, formSheetInteractive, transitionDrawer, openSourceDrawer } =
    useNewWorktreeDrawerNavigation(visible)
  const createInFlightRef = useRef(false)
  const setupTrustActionInFlightRef = useRef(false)
  const [selectedAgentState, setSelectedAgent] = useState<AgentOption>(AGENT_OPTIONS[0]!)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null)
  const [detectedAgentIdsState, setDetectedAgentIdsState] = useState<DetectedAgentIdsState | null>(
    null
  )
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const [sshState, setSshState] = useState<SshConnectionState | null>(null)
  const [sshConnectingTargetId, setSshConnectingTargetId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [availableProviders, setAvailableProviders] = useState<TaskProvider[]>([])
  const { tasksSupported, getWorktreeCreateCutoverSupport } = useNewWorktreeRuntimeCapabilities(
    client,
    visible
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [setupHookDetails, setSetupHookDetails] = useState<SetupHookDetails | null>(null)
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [setupTrustPrompt, setSetupTrustPrompt] = useState<SetupTrustPrompt | null>(null)
  const [setupDecisionChoice, setSetupDecisionChoice] = useState<Exclude<
    SetupDecision,
    'inherit'
  > | null>(null)
  const [runSetup, setRunSetup] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)
  const selectedRepoWorktreeBranches = useMemo(
    () => getComposerRepoWorktreeBranches(existingWorktrees ?? [], selectedRepo?.id ?? null),
    [existingWorktrees, selectedRepo]
  )

  const composer = useMobileComposerSource({
    client,
    selectedRepoId: selectedRepo?.id ?? null,
    worktreeBranches: selectedRepoWorktreeBranches,
    onError: setError
  })

  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const sshGate = deriveWorkspaceSshGate({
    connectionId: selectedRepoConnectionId,
    state: sshState,
    connecting: sshConnectingTargetId === selectedRepoConnectionId
  })
  const detectedAgentIds =
    detectedAgentIdsState?.connectionId === selectedRepoConnectionId &&
    (selectedRepoConnectionId === null || sshGate.status === 'connected')
      ? detectedAgentIdsState.ids
      : null
  const activeSetupHookDetails =
    selectedRepo && setupHookDetails?.repoId === selectedRepo.id ? setupHookDetails : null
  const setupCommand = activeSetupHookDetails?.command ?? null
  const setupSource = activeSetupHookDetails?.source ?? null
  const setupTrust = activeSetupHookDetails?.trust ?? null
  const setupRunPolicy = activeSetupHookDetails?.runPolicy ?? 'run-by-default'
  const selectedAgentResolution = resolveNewWorktreeAgentSelection({
    visible,
    selectedAgent: selectedAgentState,
    agentOverridden: agentOverriddenState,
    runtimeSettings,
    detectedAgentIds
  })
  // Why: agent preference repair is pure render dataflow; doing it here
  // avoids a stale selected-agent commit while preserving user overrides.
  if (
    selectedAgentState.id !== selectedAgentResolution.selectedAgent.id ||
    agentOverriddenState !== selectedAgentResolution.agentOverridden
  ) {
    setSelectedAgent(selectedAgentResolution.selectedAgent)
    setAgentOverridden(selectedAgentResolution.agentOverridden)
  }
  const selectedAgent = selectedAgentResolution.selectedAgent

  const selectedRepoIsGit = selectedRepo ? selectedRepo.kind !== 'folder' : true
  const sourceAvailability: SmartModeAvailabilityInput = {
    textOnly: selectedRepo != null && !selectedRepoIsGit,
    tasksSupported,
    hasRepo: selectedRepo != null,
    githubAvailable: availableProviders.includes('github'),
    gitlabAvailable: availableProviders.includes('gitlab'),
    linearAvailable: availableProviders.includes('linear')
  }
  const pasteRepos = useMemo<PasteRepoCandidate[]>(
    () =>
      repos.map((repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        slug: deriveRepoSlug(repo)
      })),
    [repos]
  )

  useEffect(() => {
    if (!visible || !lastVisitedRepo.loaded || selectedRepo || repos.length === 0) {
      return
    }
    const eligibleRepos = getMobileNewWorkspaceDialogEligibleRepos(repos)
    const preferredRepoId = resolveMobileNewWorkspaceDialogRepoId({
      eligibleRepos,
      activeRepoId: lastVisitedRepo.repoId
    })
    const preferredRepo = repos.find((repo) => repo.id === preferredRepoId) ?? null
    if (preferredRepo) {
      setSelectedRepo(preferredRepo)
    }
  }, [lastVisitedRepo.loaded, lastVisitedRepo.repoId, repos, selectedRepo, visible])

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false

    if (repos.length === 0) {
      setLoading(true)
    }

    void client
      .sendRequest('repo.list')
      .then((repoResponse) => {
        if (stale) {
          return
        }
        if (repoResponse.ok) {
          const result = (repoResponse as RpcSuccess).result as { repos: Repo[] }
          setRepos(result.repos)
          if (hostId) {
            setCachedRepos(hostId, result.repos)
          }
          setSelectedRepo((current) => {
            // Why: the optimistic cache can include repos removed before the
            // fresh repo.list returns; never create against a stale repo id.
            return refreshMobileNewWorkspaceDialogSelectedRepo(result.repos, current)
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setRepos([])
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })

    void (async () => {
      // Why: settle each RPC independently so a flaky availability probe (e.g. a
      // linear.status timeout, which rejects rather than resolving {ok:false})
      // can't discard the already-resolved critical settings/ui results.
      const probes = Promise.allSettled([
        client.sendRequest('preflight.check'),
        client.sendRequest('linear.status')
      ])
      const okResult = (entry: PromiseSettledResult<RpcResponse>): RpcSuccess | null =>
        entry.status === 'fulfilled' && entry.value.ok ? (entry.value as RpcSuccess) : null
      // Why: hydrate settings/trust the moment their own RPCs settle — gating them
      // on the probes (a first-open preflight.check can take seconds) widens the
      // window where an already-trusted setup hook spuriously re-prompts on create.
      const [settingsRes, uiRes] = await Promise.allSettled([
        client.sendRequest('settings.get'),
        client.sendRequest('ui.get')
      ])
      if (stale) {
        return
      }

      const settingsResult = okResult(settingsRes)
      const settingsValue = settingsResult
        ? (
            settingsResult.result as {
              settings: RuntimeSettings & { visibleTaskProviders?: unknown }
            }
          ).settings
        : null
      if (settingsValue) {
        setRuntimeSettings(settingsValue)
      }
      const uiResult = okResult(uiRes)
      if (uiResult) {
        const ui = (uiResult.result as { ui?: { trustedOrcaHooks?: PersistedTrustedOrcaHooks } }).ui
        setTrustedOrcaHooks(ui?.trustedOrcaHooks ?? {})
      }

      const [preflightRes, linearRes] = await probes
      if (stale) {
        return
      }
      const glabInstalled =
        (okResult(preflightRes)?.result as { glab?: { installed?: boolean } } | undefined)?.glab
          ?.installed === true
      const linearConnected =
        (okResult(linearRes)?.result as { connected?: boolean } | undefined)?.connected === true
      const visibleProviders = normalizeVisibleTaskProviders(settingsValue?.visibleTaskProviders)
      setAvailableProviders(
        // Drop filterAvailableTaskProviders' forced 'github' fallback when the user
        // hid GitHub; the Branch tab always guarantees at least one tab remains.
        filterAvailableTaskProviders(visibleProviders, {
          gitlabInstalled: glabInstalled,
          linearConnected
        }).filter((provider) => visibleProviders.includes(provider))
      )
    })()
    return () => {
      stale = true
    }
  }, [visible, client, hostId])

  useEffect(() => {
    if (!visible || !client || !selectedRepoConnectionId) {
      return
    }
    let stale = false
    void client
      .sendRequest('ssh.getState', { targetId: selectedRepoConnectionId })
      .then((response) => {
        if (stale) {
          return
        }
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        const state = (response as RpcSuccess).result as { state?: SshConnectionState | null }
        setSshState(
          state.state ?? {
            targetId: selectedRepoConnectionId,
            status: 'disconnected',
            error: null,
            reconnectAttempt: 0
          }
        )
      })
      .catch((err) => {
        if (!stale) {
          setSshState({
            targetId: selectedRepoConnectionId,
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to read SSH connection state.',
            reconnectAttempt: 0
          })
        }
      })
    return () => {
      stale = true
    }
  }, [client, selectedRepoConnectionId, visible])

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    if (selectedRepoConnectionId && sshGate.status !== 'connected') {
      return
    }
    let stale = false
    void (async () => {
      try {
        const response = selectedRepoConnectionId
          ? await client.sendRequest('preflight.detectRemoteAgents', {
              connectionId: selectedRepoConnectionId
            })
          : await client.sendRequest('preflight.detectAgents')
        if (stale) {
          return
        }
        setDetectedAgentIdsState({
          connectionId: selectedRepoConnectionId,
          ids: response.ok ? new Set((response as RpcSuccess).result as string[]) : new Set()
        })
      } catch {
        if (!stale) {
          setDetectedAgentIdsState({ connectionId: selectedRepoConnectionId, ids: new Set() })
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [client, selectedRepoConnectionId, sshGate.status, visible])

  useEffect(() => {
    if (!client || !selectedRepo) {
      return
    }
    let stale = false
    void (async () => {
      try {
        const response = await client.sendRequest('repo.hooks', {
          repo: `id:${selectedRepo.id}`
        })
        if (stale) {
          return
        }
        if (response.ok) {
          const result = (response as RpcSuccess).result as RepoHooksResponse
          const cmd = result.hooks?.scripts?.setup?.trim() || null
          const policy = result.setupRunPolicy ?? 'run-by-default'
          setSetupHookDetails({
            repoId: selectedRepo.id,
            command: cmd,
            source: result.source,
            trust: normalizeSetupHookTrust(result.setupTrust),
            runPolicy: policy
          })
          setSetupDecisionChoice(null)
          setRunSetup(policy !== 'skip-by-default')
          if (cmd && policy === 'ask') {
            setShowAdvanced(true)
          }
        }
      } catch {
        if (!stale) {
          setSetupHookDetails({
            repoId: selectedRepo.id,
            command: null,
            source: null,
            trust: null,
            runPolicy: 'run-by-default'
          })
          setSetupDecisionChoice(null)
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [client, selectedRepo])

  async function connectSelectedSshRepo(): Promise<void> {
    if (!client || !selectedRepoConnectionId) {
      return
    }
    setSshConnectingTargetId(selectedRepoConnectionId)
    setSshState({
      targetId: selectedRepoConnectionId,
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    })
    try {
      const response = await client.sendRequest(
        'ssh.connect',
        { targetId: selectedRepoConnectionId },
        { timeoutMs: 120_000 }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = (response as RpcSuccess).result as { state?: SshConnectionState | null }
      setSshState(
        result.state ?? {
          targetId: selectedRepoConnectionId,
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        }
      )
    } catch (err) {
      setSshState({
        targetId: selectedRepoConnectionId,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to connect to SSH repository.',
        reconnectAttempt: 0
      })
    } finally {
      setSshConnectingTargetId((current) => (current === selectedRepoConnectionId ? null : current))
    }
  }

  async function handleCreate(options: CreateOptions = {}) {
    if (!client || !selectedRepo || createInFlightRef.current) {
      return
    }
    createInFlightRef.current = true
    setCreating(true)
    setError('')

    try {
      if (sshGate.requiresConnection) {
        setError(`Connect ${selectedRepo.displayName} before creating a workspace.`)
        return
      }
      let latestRuntimeSettings = runtimeSettings
      try {
        const settingsResponse = await client.sendRequest('settings.get')
        if (settingsResponse.ok) {
          const result = (settingsResponse as RpcSuccess).result as { settings: RuntimeSettings }
          latestRuntimeSettings = result.settings
          setRuntimeSettings(result.settings)
        }
      } catch {
        // Best-effort refresh; the runtime validates the same setting before spawning.
      }
      if (
        selectedAgent.id !== '__blank__' &&
        !isMobileTuiAgentEnabled(selectedAgent.id, latestRuntimeSettings?.disabledTuiAgents)
      ) {
        setSelectedAgent(pickPreferredNewWorktreeAgent(latestRuntimeSettings, detectedAgentIds))
        setAgentOverridden(false)
        setError('Selected agent is disabled. Choose an enabled agent before creating.')
        return
      }

      const command =
        selectedAgent.id !== '__blank__'
          ? (latestRuntimeSettings?.agentCmdOverrides?.[selectedAgent.id] ??
            (isMobileTuiAgent(selectedAgent.id)
              ? MOBILE_TUI_AGENT_LAUNCH_COMMANDS[selectedAgent.id]
              : undefined))
          : undefined

      // Why: blank name field — match desktop behavior by computing the
      // next available marine-creature name at submit time and passing it
      // to the server. The server's worktree.create rejects empty/invalid
      // names, so we must generate one client-side rather than letting the
      // server invent one. The pre-flight basename dedupe is only a hint;
      // the authoritative collision is checked server-side against git
      // branches/remotes/PRs, so we also retry-with-suffix on conflict.
      const trimmedName = composer.name.trim()
      const baseName = trimmedName || getSuggestedCreatureName(existingWorktreePaths ?? [])

      let setupDecision: SetupDecision = 'inherit'
      if (setupCommand) {
        if (options.setupOverride) {
          setupDecision = options.setupOverride
        } else if (setupRunPolicy === 'ask') {
          if (!setupDecisionChoice) {
            setError('Choose whether to run the setup script.')
            return
          }
          setupDecision = setupDecisionChoice
        } else {
          setupDecision = runSetup ? 'run' : 'skip'
        }
      }
      if (
        setupDecision === 'run' &&
        setupTrust &&
        setupTrust.contentHash !== options.approvedSetupContentHash &&
        !isSetupHookTrusted(trustedOrcaHooks, selectedRepo.id, setupTrust.contentHash)
      ) {
        // Why: desktop prompts before running repo-owned orca.yaml setup hooks.
        // Mobile stores the same trust hash so approvals carry across surfaces.
        setSetupTrustPrompt({
          repoId: selectedRepo.id,
          repoName: selectedRepo.displayName,
          scriptContent: setupTrust.scriptContent,
          contentHash: setupTrust.contentHash,
          previouslyApproved: wasSetupHookPreviouslyApproved(trustedOrcaHooks, selectedRepo.id)
        })
        transitionDrawer('trust')
        return
      }

      const createdWithAgentId = selectedAgent.id !== '__blank__' ? selectedAgent.id : undefined
      const trimmedNote = note.trim() || undefined
      const createSelection = composer.createSelection
      const result = createSelection
        ? await createWorkspaceFromComposerSource({
            client,
            selection: createSelection,
            targetRepoId: selectedRepo.id,
            setupDecision,
            agent: {
              choice: normalizeWorkspaceAgent(selectedAgent.id) ?? 'blank',
              startupCommand: command
            },
            workspaceName: trimmedName || undefined,
            note: trimmedNote,
            nameIsAutoManaged: composer.isNameAutoManaged,
            supportsIdempotentCutoverRetry: getWorktreeCreateCutoverSupport()
          })
        : await createBlankWorkspace({
            client,
            repoId: selectedRepo.id,
            baseName,
            startupCommand: command,
            createdWithAgentId,
            comment: trimmedNote,
            setupDecision,
            supportsIdempotentCutoverRetry: getWorktreeCreateCutoverSupport()
          })
      if ('error' in result) {
        setError(result.error)
        return
      }
      onClose()
      onCreated(result.worktreeId, result.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workspace')
    } finally {
      createInFlightRef.current = false
      setCreating(false)
    }
  }

  const needsSetupChoice = Boolean(setupCommand) && setupRunPolicy === 'ask'
  const canCreate =
    selectedRepo != null &&
    !creating &&
    !sshGate.requiresConnection &&
    (!needsSetupChoice || setupDecisionChoice != null)
  const visibleAgentOptions =
    detectedAgentIds === null
      ? AGENT_OPTIONS.filter(
          (agent) =>
            agent.id !== '__blank__' &&
            isMobileTuiAgentEnabled(agent.id, runtimeSettings?.disabledTuiAgents)
        )
      : AGENT_OPTIONS.filter(
          (agent) =>
            agent.id !== '__blank__' &&
            detectedAgentIds.has(agent.id) &&
            isMobileTuiAgentEnabled(agent.id, runtimeSettings?.disabledTuiAgents)
        )
  const pickerAgentOptions = [...visibleAgentOptions, BLANK_TERMINAL]
  const repoPickerItems = useMemo(
    () => repos.map((repo) => ({ id: repo.id, label: repo.displayName, repo })),
    [repos]
  )

  function prepareSelectionPickerOpen(): void {
    // Why: picker taps can beat an open soft keyboard; dismissing it prevents the
    // keyboard from reopening under the picker drawer.
    Keyboard.dismiss()
  }

  function handleRepoSelected(repo: Repo): void {
    const repoChanged = repo.id !== selectedRepo?.id
    setSelectedRepo(repo)
    // Branch and provider-backed sources are repo-scoped; Linear/Jira are global
    // work context and survive choosing a different implementation repo.
    if (repoChanged && !shouldPreserveWorkspaceSourceOnRepoChange(composer.linkedWorkItem)) {
      composer.handleClearSmartNameSelection()
    }
  }

  async function approveSetupTrust(alwaysTrust: boolean): Promise<void> {
    if (
      !client ||
      !setupTrustPrompt ||
      setupTrustActionInFlightRef.current ||
      createInFlightRef.current
    ) {
      return
    }
    setupTrustActionInFlightRef.current = true
    setCreating(true)
    try {
      const nextTrust = await persistSetupHookTrustApproval({
        client,
        trust: trustedOrcaHooks,
        repoId: setupTrustPrompt.repoId,
        contentHash: setupTrustPrompt.contentHash,
        alwaysTrust
      })
      setTrustedOrcaHooks(nextTrust)
      const approvedHash = setupTrustPrompt.contentHash
      setSetupTrustPrompt(null)
      transitionDrawer('form')
      await handleCreate({ setupOverride: 'run', approvedSetupContentHash: approvedHash })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
    } finally {
      setupTrustActionInFlightRef.current = false
      if (!createInFlightRef.current) {
        setCreating(false)
      }
    }
  }

  function closeSetupTrust(): void {
    if (setupTrustActionInFlightRef.current || createInFlightRef.current) {
      return
    }
    setSetupTrustPrompt(null)
    transitionDrawer('form')
  }

  function skipSetupTrust(): void {
    if (setupTrustActionInFlightRef.current || createInFlightRef.current) {
      return
    }
    closeSetupTrust()
    void handleCreate({ setupOverride: 'skip' })
  }

  return (
    // Why: hosting the form and every picker in one persistent native Modal makes
    // form → repo/agent transitions in-window view swaps, avoiding the iOS
    // dismiss-then-present race that left the dropdowns unresponsive. Native back
    // closes the flow from the form, routes the trust prompt through its in-flight
    // guard, and otherwise returns to the form from a picker.
    <BottomDrawerModalHost
      visible={visible}
      onRequestClose={() => {
        if (drawerView === 'form') {
          onClose()
        } else if (drawerView === 'trust') {
          closeSetupTrust()
        } else {
          transitionDrawer('form')
        }
      }}
    >
      <BottomDrawer visible={formSheetVisible} interactive={formSheetInteractive} onClose={onClose}>
        <View style={styles.header}>
          <Text style={styles.title}>Create Workspace</Text>
          <Text style={styles.subtitle}>
            Pick a repository and agent to spin up a new workspace.
          </Text>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : repos.length === 0 ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.emptyText}>No repositories found</Text>
          </View>
        ) : (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>Repository</Text>
              <Pressable
                style={styles.fieldButton}
                onPress={() => {
                  prepareSelectionPickerOpen()
                  transitionDrawer('repo')
                }}
              >
                {selectedRepo ? (
                  <View
                    style={[styles.repoDot, { backgroundColor: repoBadgeColor(selectedRepo) }]}
                  />
                ) : null}
                <Text
                  style={[styles.fieldButtonText, !selectedRepo && styles.fieldButtonPlaceholder]}
                  numberOfLines={1}
                >
                  {selectedRepo?.displayName ?? 'Select a repository'}
                </Text>
                <ChevronDown size={14} color={colors.textMuted} />
              </Pressable>
            </View>

            <SmartWorkspaceSourceField
              composer={composer}
              label={selectedRepoIsGit ? "Name or 'Create From'" : 'Workspace name'}
              disabled={sshGate.requiresConnection}
              interactive={formSheetInteractive}
              onBeforeOpen={() => setError('')}
              onOpenDrawer={openSourceDrawer}
            />

            {composer.forkPushWarning ? (
              <Text style={styles.sourceWarning}>{composer.forkPushWarning}</Text>
            ) : null}

            {selectedRepoConnectionId ? (
              <View style={styles.field}>
                <Text style={styles.label}>SSH Connection</Text>
                <View style={styles.sshBox}>
                  <View style={styles.sshRow}>
                    <View
                      style={[
                        styles.sshDot,
                        sshGate.status === 'connected'
                          ? styles.sshDotConnected
                          : sshGate.connectInProgress
                            ? styles.sshDotProgress
                            : styles.sshDotDisconnected
                      ]}
                    />
                    <View style={styles.sshCopy}>
                      <Text style={styles.sshTitle} numberOfLines={1}>
                        {selectedRepo?.displayName ?? 'Remote repository'}
                      </Text>
                      <Text style={styles.sshSubtitle}>
                        {workspaceSshStatusLabel(sshGate.status)}
                      </Text>
                    </View>
                    {sshGate.status === 'connected' ? null : (
                      <Pressable
                        style={[
                          styles.sshConnectButton,
                          sshGate.connectInProgress && styles.disabled
                        ]}
                        disabled={sshGate.connectInProgress}
                        onPress={() => void connectSelectedSshRepo()}
                      >
                        <Text style={styles.sshConnectText}>
                          {sshGate.connectInProgress ? 'Connecting...' : 'Connect'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {sshGate.error ? <Text style={styles.errorInline}>{sshGate.error}</Text> : null}
                </View>
              </View>
            ) : null}

            <View style={styles.field}>
              <Text style={styles.label}>Agent</Text>
              <Pressable
                style={[styles.fieldButton, sshGate.requiresConnection && styles.disabled]}
                disabled={sshGate.requiresConnection}
                onPress={() => {
                  prepareSelectionPickerOpen()
                  transitionDrawer('agent')
                }}
              >
                <MobileAgentIcon agentId={selectedAgent.id} size={16} />
                <Text style={styles.fieldButtonText} numberOfLines={1}>
                  {sshGate.requiresConnection ? 'Connect repository first' : selectedAgent.label}
                </Text>
                <ChevronDown size={14} color={colors.textMuted} />
              </Pressable>
            </View>

            <Pressable style={styles.advancedToggle} onPress={() => setShowAdvanced(!showAdvanced)}>
              <Text style={styles.advancedText}>Advanced</Text>
              {showAdvanced ? (
                <ChevronUp size={14} color={colors.textSecondary} />
              ) : (
                <ChevronDown size={14} color={colors.textSecondary} />
              )}
            </Pressable>

            {showAdvanced && (
              <>
                <SmartWorkspaceAdvancedFields
                  composer={composer}
                  selectedRepoIsGit={selectedRepoIsGit}
                />

                <View style={styles.field}>
                  <Text style={styles.label}>Note</Text>
                  <TextInput
                    style={styles.input}
                    value={note}
                    onChangeText={setNote}
                    placeholder="Write a note"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                {setupCommand ? (
                  <View style={styles.field}>
                    <View style={styles.setupHeader}>
                      <Text style={styles.label}>Setup script</Text>
                      {setupSource && (
                        <View style={styles.sourceBadge}>
                          <Text style={styles.sourceBadgeText}>
                            {setupSource === 'orca.yaml' ? 'ORCA.YAML' : 'HOOKS'}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.setupBox}>
                      {setupRunPolicy === 'ask' ? (
                        <View style={styles.setupChoiceRow}>
                          <Pressable
                            style={[
                              styles.setupChoiceButton,
                              setupDecisionChoice === 'run' && styles.setupChoiceButtonSelected
                            ]}
                            onPress={() => setSetupDecisionChoice('run')}
                          >
                            <Text style={styles.setupChoiceText}>Run</Text>
                          </Pressable>
                          <Pressable
                            style={[
                              styles.setupChoiceButton,
                              setupDecisionChoice === 'skip' && styles.setupChoiceButtonSelected
                            ]}
                            onPress={() => setSetupDecisionChoice('skip')}
                          >
                            <Text style={styles.setupChoiceText}>Skip</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <View style={styles.setupToggleRow}>
                          <Text style={styles.setupToggleLabel}>Run setup command</Text>
                          <Switch
                            value={runSetup}
                            onValueChange={setRunSetup}
                            trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
                            thumbColor={colors.textPrimary}
                            style={styles.setupSwitch}
                          />
                        </View>
                      )}
                      <View style={styles.setupCommandBlock}>
                        <Text style={styles.setupCommand}>{setupCommand}</Text>
                      </View>
                    </View>
                  </View>
                ) : null}
              </>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                style={[styles.createButton, !canCreate && styles.createButtonDisabled]}
                disabled={!canCreate}
                onPress={() => void handleCreate()}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={colors.bgBase} />
                ) : (
                  <Text style={styles.createText}>
                    {sshGate.requiresConnection ? 'Connect Repository' : 'Create Workspace'}
                  </Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </BottomDrawer>

      {/* Why: list drawers stay outside the form's ScrollView, and the transition
          state lets each hosted overlay finish hiding before the next appears. */}
      <SmartWorkspaceSourceDrawer
        visible={visible && drawerView === 'source'}
        client={client}
        composer={composer}
        availability={sourceAvailability}
        repoId={selectedRepo?.id ?? null}
        repos={pasteRepos}
        sshReady={!sshGate.requiresConnection}
        onRepoChange={(repoId) => {
          const nextRepo = repos.find((repo) => repo.id === repoId)
          if (nextRepo) {
            setSelectedRepo(nextRepo)
          }
        }}
        onClose={() => transitionDrawer('form')}
      />

      <PickerListDrawer
        visible={visible && drawerView === 'repo'}
        title="Repository"
        items={repoPickerItems}
        selectedId={selectedRepo?.id ?? ''}
        onSelect={(item) => handleRepoSelected(item.repo)}
        onClose={() => transitionDrawer('form')}
        renderIcon={(item) => {
          return <View style={[styles.repoDot, { backgroundColor: repoBadgeColor(item.repo) }]} />
        }}
      />

      <PickerListDrawer
        visible={visible && drawerView === 'agent'}
        title="Agent"
        items={pickerAgentOptions}
        selectedId={selectedAgent.id}
        onSelect={(agent) => {
          setAgentOverridden(true)
          setSelectedAgent(agent)
        }}
        onClose={() => transitionDrawer('form')}
        renderIcon={(agent) => <MobileAgentIcon agentId={agent.id} size={18} />}
      />

      <SetupHookTrustDrawer
        visible={visible && drawerView === 'trust' && setupTrustPrompt != null}
        prompt={setupTrustPrompt}
        busy={creating}
        onRunOnce={() => void approveSetupTrust(false)}
        onAlwaysTrust={() => void approveSetupTrust(true)}
        onDontRun={skipSetupTrust}
        onClose={closeSetupTrust}
      />
    </BottomDrawerModalHost>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  loadingContainer: {
    paddingVertical: spacing.xl,
    alignItems: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  field: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
  },
  labelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  fieldButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  fieldButtonText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  fieldButtonPlaceholder: {
    color: colors.textMuted
  },
  repoDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  disabled: {
    opacity: 0.55
  },
  sshBox: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  sshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sshDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  sshDotConnected: {
    backgroundColor: colors.statusGreen
  },
  sshDotProgress: {
    backgroundColor: colors.statusAmber
  },
  sshDotDisconnected: {
    backgroundColor: colors.statusRed
  },
  sshCopy: {
    flex: 1,
    minWidth: 0
  },
  sshTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  sshSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 1
  },
  sshConnectButton: {
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sshConnectText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  errorInline: {
    color: colors.statusRed,
    fontSize: 12
  },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: typography.bodySize,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  error: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.md
  },
  sourceWarning: {
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
    fontSize: 12,
    color: colors.statusAmber
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs
  },
  advancedText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textSecondary
  },
  setupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs
  },
  sourceBadge: {
    backgroundColor: colors.bgRaised,
    borderRadius: 4,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2
  },
  sourceBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5
  },
  setupBox: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md
  },
  setupToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm
  },
  setupToggleLabel: {
    fontSize: 13,
    color: colors.textSecondary
  },
  setupChoiceRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  setupChoiceButton: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingVertical: spacing.sm
  },
  setupChoiceButtonSelected: {
    backgroundColor: colors.bgPanel,
    borderColor: colors.textSecondary
  },
  setupChoiceText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  setupSwitch: {
    transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }]
  },
  setupCommandBlock: {
    backgroundColor: colors.bgBase,
    borderRadius: 6,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm
  },
  setupCommand: {
    fontSize: 13,
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  createButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    minWidth: 160,
    alignItems: 'center'
  },
  createButtonDisabled: {
    opacity: 0.4
  },
  createText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
