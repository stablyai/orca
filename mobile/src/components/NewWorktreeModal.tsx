import { useState, useEffect, useMemo, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  StyleSheet,
  Platform,
  ActivityIndicator
} from 'react-native'
import { ChevronDown, ChevronUp, Check } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { PickerListDrawer } from './PickerListDrawer'
import { MobileAgentIcon } from './MobileAgentIcon'
import { getSuggestedCreatureName } from './worktree-name-suggestion'
import { deriveWorkspaceSshGate, workspaceSshStatusLabel } from '../tasks/workspace-ssh-gate'
import { WORKTREE_CREATE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  trustedOrcaHooksWithSetupApproval,
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

type Repo = {
  id: string
  displayName: string
  path: string
  badgeColor?: string
  connectionId?: string | null
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

type SetupTrustPrompt = {
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
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
  onCreated: (worktreeId: string, name: string) => void
  onClose: () => void
}

export function NewWorktreeModal({
  visible,
  client,
  hostId,
  existingWorktreePaths,
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
  onCreated,
  onClose
}: Props) {
  const [initialRepos] = useState(() => (hostId ? (getCachedRepos(hostId) as Repo[] | null) : null))
  const [repos, setRepos] = useState<Repo[]>(initialRepos ?? [])
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(
    initialRepos?.length === 1 ? initialRepos[0]! : null
  )
  const [showRepoPicker, setShowRepoPicker] = useState(false)
  const [selectedAgentState, setSelectedAgent] = useState<AgentOption>(AGENT_OPTIONS[0]!)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null)
  const [detectedAgentIdsState, setDetectedAgentIdsState] = useState<DetectedAgentIdsState | null>(
    null
  )
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [sshState, setSshState] = useState<SshConnectionState | null>(null)
  const [sshConnectingTargetId, setSshConnectingTargetId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
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

  // Why: matches the desktop UI — the input shows a generic "Workspace name"
  // placeholder, not the suggested creature. The creature name is only used
  // as a server-bound fallback when the user submits with a blank field, so
  // it's recomputed lazily inside handleCreate() to stay fresh against
  // existingWorktreePaths at submission time.

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
            if (current) {
              return result.repos.find((repo) => repo.id === current.id) ?? current
            }
            return result.repos.length === 1 ? result.repos[0]! : null
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
      try {
        const [settingsResponse, uiResponse] = await Promise.all([
          client.sendRequest('settings.get'),
          client.sendRequest('ui.get')
        ])
        if (stale) {
          return
        }
        if (settingsResponse.ok) {
          const result = (settingsResponse as RpcSuccess).result as { settings: RuntimeSettings }
          setRuntimeSettings(result.settings)
        }
        if (uiResponse.ok) {
          const result = (uiResponse as RpcSuccess).result as {
            ui?: { trustedOrcaHooks?: PersistedTrustedOrcaHooks }
          }
          setTrustedOrcaHooks(result.ui?.trustedOrcaHooks ?? {})
        }
      } catch {
        // Non-critical; repo.list owns the visible loading state.
      }
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

  async function persistSetupHookTrust(
    repoId: string,
    contentHash: string,
    alwaysTrust: boolean
  ): Promise<void> {
    if (!client) {
      return
    }
    const next = trustedOrcaHooksWithSetupApproval({
      trust: trustedOrcaHooks,
      repoId,
      contentHash,
      alwaysTrust
    })
    const response = await client.sendRequest('ui.set', { trustedOrcaHooks: next })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    setTrustedOrcaHooks(next)
  }

  async function handleCreate(options: CreateOptions = {}) {
    if (!client || !selectedRepo) {
      return
    }
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
      const trimmedName = name.trim()
      const baseName = trimmedName || getSuggestedCreatureName(existingWorktreePaths ?? [])

      // Why: mirrors src/renderer/src/store/slices/worktrees.ts
      // (createWorktree retry loop). Server-side checks (Branch X already
      // exists locally / on a remote / already has PR #N) can fire even
      // after the pre-flight basename dedupe — branches outlive worktrees
      // in git, and remote branches/PRs aren't visible from worktree.ps.
      // Retry up to 25 times by appending -2, -3, ... before surfacing
      // the error. The desktop applies this to user-typed names too, so
      // mobile follows suit for parity.
      const retryablePatterns = [
        /already exists locally/i,
        /already exists on a remote/i,
        /already has pr #\d+/i
      ]
      const candidateFor = (attempt: number): string =>
        attempt === 0 ? baseName : `${baseName}-${attempt + 1}`
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
        return
      }

      let lastError: string | null = null
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidateName = candidateFor(attempt)
        const params: Record<string, unknown> = {
          repo: `id:${selectedRepo.id}`,
          startupCommand: command,
          setupDecision,
          name: candidateName
        }
        if (selectedAgent.id !== '__blank__') {
          params.createdWithAgent = selectedAgent.id
        }
        if (note.trim()) {
          params.comment = note.trim()
        }

        const response = await client.sendRequest('worktree.create', params, {
          timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
        })
        if (response.ok) {
          const result = (response as RpcSuccess).result as { worktree: { id: string } }
          onClose()
          onCreated(result.worktree.id, candidateName)
          return
        }

        lastError = response.error.message
        if (!retryablePatterns.some((p) => p.test(lastError ?? ''))) {
          break
        }
      }
      setError(lastError ?? 'Failed to create workspace')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create workspace')
    } finally {
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

  return (
    <>
      <BottomDrawer visible={visible} onClose={onClose}>
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
              <Pressable style={styles.fieldButton} onPress={() => setShowRepoPicker(true)}>
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
              <Text style={styles.label}>
                Workspace Name <Text style={styles.labelHint}>[Optional]</Text>
              </Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={(t) => {
                  setName(t)
                  setError('')
                }}
                placeholder="Workspace name"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus={repos.length <= 1}
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (canCreate) {
                    void handleCreate()
                  }
                }}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Agent</Text>
              <Pressable
                style={[styles.fieldButton, sshGate.requiresConnection && styles.disabled]}
                disabled={sshGate.requiresConnection}
                onPress={() => setShowAgentPicker(true)}
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

      {/* Sub-modals for pickers — rendered outside the main modal so they
          layer on top and scroll without touch conflicts. */}
      <PickerListDrawer
        visible={visible && showRepoPicker}
        title="Repository"
        items={repoPickerItems}
        selectedId={selectedRepo?.id ?? ''}
        onSelect={(item) => setSelectedRepo(item.repo)}
        onClose={() => setShowRepoPicker(false)}
        renderIcon={(item) => {
          return <View style={[styles.repoDot, { backgroundColor: repoBadgeColor(item.repo) }]} />
        }}
      />

      <PickerListDrawer
        visible={visible && showAgentPicker}
        title="Agent"
        items={pickerAgentOptions}
        selectedId={selectedAgent.id}
        onSelect={(agent) => {
          setAgentOverridden(true)
          setSelectedAgent(agent)
        }}
        onClose={() => setShowAgentPicker(false)}
        renderIcon={(agent) => <MobileAgentIcon agentId={agent.id} size={18} />}
      />

      <BottomDrawer
        visible={visible && setupTrustPrompt != null}
        onClose={() => setSetupTrustPrompt(null)}
      >
        {setupTrustPrompt ? (
          <View>
            <View style={styles.trustHeader}>
              <Text style={styles.title}>
                {setupTrustPrompt.previouslyApproved
                  ? `${setupTrustPrompt.repoName}'s setup script changed`
                  : `Run setup from ${setupTrustPrompt.repoName}?`}
              </Text>
              <Text style={styles.subtitle}>
                This repository's orca.yaml runs before the workspace starts. Only run it if you
                trust this repository.
              </Text>
            </View>

            <View style={styles.trustScriptBox}>
              <Text style={styles.trustScriptLabel}>
                {setupTrustPrompt.previouslyApproved ? 'New setup script' : 'Setup script'}
              </Text>
              <Text style={styles.trustScriptText}>{setupTrustPrompt.scriptContent}</Text>
            </View>

            <View style={styles.trustActionGroup}>
              <Pressable
                style={styles.trustActionRow}
                disabled={creating}
                onPress={() =>
                  void (async () => {
                    try {
                      await persistSetupHookTrust(
                        setupTrustPrompt.repoId,
                        setupTrustPrompt.contentHash,
                        false
                      )
                      const approvedHash = setupTrustPrompt.contentHash
                      setSetupTrustPrompt(null)
                      await handleCreate({
                        setupOverride: 'run',
                        approvedSetupContentHash: approvedHash
                      })
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
                    }
                  })()
                }
              >
                <Check size={16} color={colors.textPrimary} />
                <Text style={styles.trustActionText}>Run hooks</Text>
              </Pressable>
              <View style={styles.trustActionSeparator} />
              <Pressable
                style={styles.trustActionRow}
                disabled={creating}
                onPress={() =>
                  void (async () => {
                    try {
                      await persistSetupHookTrust(
                        setupTrustPrompt.repoId,
                        setupTrustPrompt.contentHash,
                        true
                      )
                      const approvedHash = setupTrustPrompt.contentHash
                      setSetupTrustPrompt(null)
                      await handleCreate({
                        setupOverride: 'run',
                        approvedSetupContentHash: approvedHash
                      })
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to trust setup script.')
                    }
                  })()
                }
              >
                <Check size={16} color={colors.textPrimary} />
                <Text style={styles.trustActionText}>Always trust and run</Text>
              </Pressable>
              <View style={styles.trustActionSeparator} />
              <Pressable
                style={styles.trustActionRow}
                disabled={creating}
                onPress={() => {
                  setSetupTrustPrompt(null)
                  void handleCreate({ setupOverride: 'skip' })
                }}
              >
                <Text style={styles.trustActionText}>Don't run</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </BottomDrawer>
    </>
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
  trustHeader: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  trustScriptBox: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  trustScriptLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm
  },
  trustScriptText: {
    fontSize: 13,
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  trustActionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    overflow: 'hidden'
  },
  trustActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md
  },
  trustActionText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '500'
  },
  trustActionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
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
