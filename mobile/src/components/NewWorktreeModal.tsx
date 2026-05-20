import { useState, useEffect } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Image
} from 'react-native'
import { ChevronDown, ChevronUp, Check, Terminal } from 'lucide-react-native'
import Svg, { Path, G } from 'react-native-svg'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { ClaudeIcon, OpenAIIcon } from './AgentIcons'
import { getSuggestedCreatureName } from './worktree-name-suggestion'
import { deriveWorkspaceSshGate, workspaceSshStatusLabel } from '../tasks/workspace-ssh-gate'
import { MOBILE_AGENT_CATALOG } from '../tasks/mobile-agent-catalog'
import { WORKTREE_CREATE_TIMEOUT_MS } from '../tasks/workspace-create-timeout'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  trustedOrcaHooksWithSetupApproval,
  wasSetupHookPreviouslyApproved,
  type SetupHookTrust
} from '../tasks/setup-hook-trust'
import { isMobileTuiAgent, MOBILE_TUI_AGENT_LAUNCH_COMMANDS } from '../tasks/mobile-tui-agents'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/types'
import type { SshConnectionState } from '../../../src/shared/ssh-types'

type Repo = {
  id: string
  displayName: string
  path: string
  connectionId?: string | null
}

type SetupDecision = 'inherit' | 'run' | 'skip'
type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
type RuntimeSettings = {
  defaultTuiAgent?: string | 'blank' | null
  agentCmdOverrides?: Record<string, string>
}

type RepoHooksResponse = {
  hooks: { scripts?: { setup?: string } } | null
  source: string | null
  setupRunPolicy?: SetupRunPolicy
  setupTrust?: SetupHookTrust
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

type AgentOption = {
  id: string
  label: string
  faviconDomain?: string
}

const AGENT_OPTIONS: AgentOption[] = MOBILE_AGENT_CATALOG

const BLANK_TERMINAL: AgentOption = { id: '__blank__', label: 'Blank Terminal' }

function agentOptionFor(id: string | null | undefined): AgentOption | null {
  if (!id) return null
  if (id === 'blank' || id === '__blank__') return BLANK_TERMINAL
  return AGENT_OPTIONS.find((agent) => agent.id === id) ?? null
}

function pickPreferredAgent(
  settings: RuntimeSettings | null,
  detectedAgentIds: Set<string> | null
): AgentOption {
  const preferred = agentOptionFor(settings?.defaultTuiAgent)
  if (preferred?.id === '__blank__') {
    return preferred
  }
  if (preferred && (detectedAgentIds === null || detectedAgentIds.has(preferred.id)))
    return preferred
  const detectedOption = AGENT_OPTIONS.find(
    (agent) => detectedAgentIds === null || detectedAgentIds.has(agent.id)
  )
  return detectedOption ?? BLANK_TERMINAL
}

// ── Agent icons ─────────────────────────────────────────────────────
// SVG paths sourced from the desktop codebase:
//   Claude & OpenAI: shared in ./AgentIcons.tsx
//   Pi & Aider: src/renderer/src/lib/agent-catalog.tsx
// Agents with a faviconDomain use Google's favicon service (same as desktop).

function PiIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800">
      <Path
        fill={colors.textPrimary}
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <Path fill={colors.textPrimary} d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </Svg>
  )
}

function AiderIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 436 436">
      <G transform="translate(0,436) scale(0.1,-0.1)" fill={colors.textPrimary} stroke="none">
        <Path d="M0 2180 l0 -2180 2180 0 2180 0 0 2180 0 2180 -2180 0 -2180 0 0 -2180z m2705 1818 c20 -20 28 -121 30 -398 l2 -305 216 -5 c118 -3 218 -8 222 -12 3 -3 10 -46 15 -95 5 -48 16 -126 25 -172 17 -86 17 -81 -17 -233 -14 -67 -13 -365 2 -438 21 -100 22 -159 5 -247 -24 -122 -24 -363 1 -458 23 -88 23 -213 1 -330 -9 -49 -17 -109 -17 -132 l0 -43 203 0 c111 0 208 -4 216 -9 10 -6 18 -51 27 -148 8 -76 16 -152 20 -168 7 -39 -23 -361 -37 -387 -10 -18 -21 -19 -214 -16 -135 2 -208 7 -215 14 -22 22 -33 301 -21 501 6 102 8 189 5 194 -8 13 -417 12 -431 -2 -12 -12 -8 -146 8 -261 8 -55 8 -95 1 -140 -6 -35 -14 -99 -17 -143 -9 -123 -14 -141 -41 -154 -18 -8 -217 -11 -679 -11 l-653 0 -11 33 c-31 97 -43 336 -27 533 5 56 6 113 2 128 l-6 26 -194 0 c-211 0 -252 4 -261 28 -12 33 -17 392 -6 522 15 186 -2 174 260 180 115 3 213 8 217 12 4 4 1 52 -5 105 -7 54 -17 130 -22 168 -7 56 -5 91 11 171 10 55 22 130 26 166 4 36 10 72 15 79 7 12 128 15 665 19 l658 5 8 30 c5 18 4 72 -3 130 -12 115 -7 346 11 454 10 61 10 75 -1 82 -8 5 -300 9 -650 9 l-636 0 -27 25 c-18 16 -26 34 -26 57 0 18 -5 87 -10 153 -10 128 5 449 22 472 5 7 26 13 46 15 78 6 1281 3 1287 -4z" />
        <Path d="M1360 1833 c0 -5 -1 -164 -3 -356 l-2 -347 625 -1 c704 -1 708 -1 722 7 5 4 7 20 4 38 -29 141 -32 491 -6 595 9 38 8 45 -7 57 -15 11 -139 13 -675 14 -362 0 -658 -3 -658 -7z" />
      </G>
    </Svg>
  )
}

function FaviconIcon({ domain, size = 16 }: { domain: string; size?: number }) {
  return (
    <Image
      source={{ uri: `https://www.google.com/s2/favicons?domain=${domain}&sz=64` }}
      style={{ width: size, height: size, borderRadius: 2 }}
    />
  )
}

function AgentLetterIcon({ letter, size = 16 }: { letter: string; size?: number }) {
  return (
    <View
      style={[
        styles.letterIcon,
        {
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundColor: colors.textMuted + '33'
        }
      ]}
    >
      <Text style={[styles.letterIconText, { fontSize: size * 0.55, color: colors.textPrimary }]}>
        {letter}
      </Text>
    </View>
  )
}

function AgentIcon({ agentId, size = 16 }: { agentId: string; size?: number }) {
  if (agentId === 'claude') return <ClaudeIcon size={size} />
  if (agentId === 'codex') return <OpenAIIcon size={size} />
  if (agentId === 'pi') return <PiIcon size={size} />
  if (agentId === 'aider') return <AiderIcon size={size} />
  if (agentId === '__blank__') return <Terminal size={size} color={colors.textMuted} />

  const agent = AGENT_OPTIONS.find((a) => a.id === agentId)
  if (agent?.faviconDomain) {
    return <FaviconIcon domain={agent.faviconDomain} size={size} />
  }
  const label = agent?.label ?? agentId
  return <AgentLetterIcon letter={label.charAt(0).toUpperCase()} size={size} />
}

// ── Picker sub-modal ────────────────────────────────────────────────
// Why: inline dropdowns with position:absolute + ScrollView have persistent
// touch-conflict issues in React Native. A separate modal for the picker
// list is the standard mobile pattern — it scrolls reliably and feels native.

function PickerListModal<T extends { id: string; label: string }>({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  renderIcon
}: {
  visible: boolean
  title: string
  items: T[]
  selectedId: string
  onSelect: (item: T) => void
  onClose: () => void
  renderIcon?: (item: T) => React.ReactNode
}) {
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.pickerHeader}>
        <Text style={styles.pickerTitle}>{title}</Text>
      </View>
      <View style={styles.pickerGroup}>
        {items.map((item, index) => {
          const selected = item.id === selectedId
          return (
            <View key={item.id}>
              {index > 0 && <View style={styles.pickerSeparator} />}
              <Pressable
                style={({ pressed }) => [styles.pickerItem, pressed && styles.pickerItemPressed]}
                onPress={() => {
                  onSelect(item)
                  onClose()
                }}
              >
                {renderIcon?.(item)}
                <Text
                  style={[styles.pickerItemText, selected && styles.pickerItemTextSelected]}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
                {selected && <Check size={14} color={colors.textPrimary} />}
              </Pressable>
            </View>
          )
        })}
      </View>
    </BottomDrawer>
  )
}

// ── Main modal ──────────────────────────────────────────────────────

type Props = {
  visible: boolean
  client: RpcClient | null
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
  existingWorktreePaths,
  onCreated,
  onClose
}: Props) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [showRepoPicker, setShowRepoPicker] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<AgentOption>(AGENT_OPTIONS[0]!)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null)
  const [detectedAgentIds, setDetectedAgentIds] = useState<Set<string> | null>(null)
  const [agentOverridden, setAgentOverridden] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [sshState, setSshState] = useState<SshConnectionState | null>(null)
  const [sshConnecting, setSshConnecting] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [setupCommand, setSetupCommand] = useState<string | null>(null)
  const [setupSource, setSetupSource] = useState<string | null>(null)
  const [setupTrust, setSetupTrust] = useState<SetupHookTrust | null>(null)
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [setupTrustPrompt, setSetupTrustPrompt] = useState<SetupTrustPrompt | null>(null)
  const [setupRunPolicy, setSetupRunPolicy] = useState<SetupRunPolicy>('run-by-default')
  const [setupDecisionChoice, setSetupDecisionChoice] = useState<Exclude<
    SetupDecision,
    'inherit'
  > | null>(null)
  const [runSetup, setRunSetup] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  // Why: matches the desktop UI — the input shows a generic "Workspace name"
  // placeholder, not the suggested creature. The creature name is only used
  // as a server-bound fallback when the user submits with a blank field, so
  // it's recomputed lazily inside handleCreate() to stay fresh against
  // existingWorktreePaths at submission time.

  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const sshGate = deriveWorkspaceSshGate({
    connectionId: selectedRepoConnectionId,
    state: sshState,
    connecting: sshConnecting
  })

  useEffect(() => {
    if (!visible) {
      setShowRepoPicker(false)
      setShowAgentPicker(false)
      return
    }
    if (!client) return
    let stale = false
    setName('')
    setNote('')
    setShowAdvanced(false)
    setSetupCommand(null)
    setSetupSource(null)
    setSetupTrust(null)
    setTrustedOrcaHooks({})
    setSetupTrustPrompt(null)
    setSetupRunPolicy('run-by-default')
    setSetupDecisionChoice(null)
    setRunSetup(true)
    setError('')
    setCreating(false)
    setShowRepoPicker(false)
    setShowAgentPicker(false)
    setRuntimeSettings(null)
    setDetectedAgentIds(null)
    setAgentOverridden(false)
    setSshState(null)
    setSshConnecting(false)
    setSelectedAgent(AGENT_OPTIONS[0]!)
    setLoading(true)

    void (async () => {
      try {
        const [repoResponse, settingsResponse, uiResponse] = await Promise.all([
          client.sendRequest('repo.list'),
          client.sendRequest('settings.get'),
          client.sendRequest('ui.get')
        ])
        if (stale) return
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
        if (repoResponse.ok) {
          const result = (repoResponse as RpcSuccess).result as { repos: Repo[] }
          setRepos(result.repos)
          if (result.repos.length === 1) {
            setSelectedRepo(result.repos[0]!)
          } else {
            setSelectedRepo(null)
          }
        }
      } catch {
        if (!stale) setRepos([])
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => {
      stale = true
    }
  }, [visible, client])

  useEffect(() => {
    if (!visible || !client || !selectedRepoConnectionId) {
      setSshState(null)
      setSshConnecting(false)
      return
    }
    let stale = false
    void client
      .sendRequest('ssh.getState', { targetId: selectedRepoConnectionId })
      .then((response) => {
        if (stale) return
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
    if (!visible || !client) return
    if (selectedRepoConnectionId && sshGate.status !== 'connected') {
      setDetectedAgentIds(null)
      return
    }
    let stale = false
    setDetectedAgentIds(null)
    void (async () => {
      try {
        const response = selectedRepoConnectionId
          ? await client.sendRequest('preflight.detectRemoteAgents', {
              connectionId: selectedRepoConnectionId
            })
          : await client.sendRequest('preflight.detectAgents')
        if (stale) return
        setDetectedAgentIds(
          response.ok ? new Set((response as RpcSuccess).result as string[]) : new Set()
        )
      } catch {
        if (!stale) setDetectedAgentIds(new Set())
      }
    })()
    return () => {
      stale = true
    }
  }, [client, selectedRepoConnectionId, sshGate.status, visible])

  useEffect(() => {
    if (!visible || agentOverridden) return
    setSelectedAgent(pickPreferredAgent(runtimeSettings, detectedAgentIds))
  }, [agentOverridden, detectedAgentIds, runtimeSettings, visible])

  useEffect(() => {
    if (!visible || detectedAgentIds === null || selectedAgent.id === '__blank__') return
    if (detectedAgentIds.has(selectedAgent.id)) return
    setSelectedAgent(pickPreferredAgent(runtimeSettings, detectedAgentIds))
    setAgentOverridden(false)
  }, [detectedAgentIds, runtimeSettings, selectedAgent.id, visible])

  useEffect(() => {
    if (!client || !selectedRepo) {
      setSetupCommand(null)
      setSetupSource(null)
      setSetupTrust(null)
      return
    }
    let stale = false
    void (async () => {
      try {
        const response = await client.sendRequest('repo.hooks', {
          repo: `id:${selectedRepo.id}`
        })
        if (stale) return
        if (response.ok) {
          const result = (response as RpcSuccess).result as RepoHooksResponse
          const cmd = result.hooks?.scripts?.setup?.trim() || null
          const policy = result.setupRunPolicy ?? 'run-by-default'
          setSetupCommand(cmd)
          setSetupSource(result.source)
          setSetupTrust(normalizeSetupHookTrust(result.setupTrust))
          setSetupRunPolicy(policy)
          setSetupDecisionChoice(null)
          setRunSetup(policy !== 'skip-by-default')
          if (cmd && policy === 'ask') {
            setShowAdvanced(true)
          }
        }
      } catch {
        if (!stale) {
          setSetupCommand(null)
          setSetupSource(null)
          setSetupTrust(null)
          setSetupRunPolicy('run-by-default')
          setSetupDecisionChoice(null)
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [client, selectedRepo])

  async function connectSelectedSshRepo(): Promise<void> {
    if (!client || !selectedRepoConnectionId) return
    setSshConnecting(true)
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
      setSshConnecting(false)
    }
  }

  async function persistSetupHookTrust(
    repoId: string,
    contentHash: string,
    alwaysTrust: boolean
  ): Promise<void> {
    if (!client) return
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
    if (!client || !selectedRepo) return
    setCreating(true)
    setError('')

    try {
      if (sshGate.requiresConnection) {
        setError(`Connect ${selectedRepo.displayName} before creating a workspace.`)
        return
      }
      const command =
        selectedAgent.id !== '__blank__'
          ? (runtimeSettings?.agentCmdOverrides?.[selectedAgent.id] ??
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
        if (selectedAgent.id !== '__blank__') params.createdWithAgent = selectedAgent.id
        if (note.trim()) params.comment = note.trim()

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
  const agentDetectionPending =
    selectedRepo != null && !sshGate.requiresConnection && detectedAgentIds === null
  const canCreate =
    selectedRepo != null &&
    !creating &&
    !sshGate.requiresConnection &&
    !agentDetectionPending &&
    (!needsSetupChoice || setupDecisionChoice != null)
  const visibleAgentOptions =
    detectedAgentIds === null
      ? AGENT_OPTIONS
      : AGENT_OPTIONS.filter((agent) => detectedAgentIds.has(agent.id))
  const pickerAgentOptions = [...visibleAgentOptions, BLANK_TERMINAL]

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
                  if (canCreate) void handleCreate()
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
                <AgentIcon agentId={selectedAgent.id} size={16} />
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
      <PickerListModal
        visible={visible && showRepoPicker}
        title="Repository"
        items={repos.map((r) => ({ id: r.id, label: r.displayName, _repo: r }))}
        selectedId={selectedRepo?.id ?? ''}
        onSelect={(item) => setSelectedRepo((item as { _repo: Repo })._repo)}
        onClose={() => setShowRepoPicker(false)}
      />

      <PickerListModal
        visible={visible && showAgentPicker}
        title="Agent"
        items={pickerAgentOptions}
        selectedId={selectedAgent.id}
        onSelect={(agent) => {
          setAgentOverridden(true)
          setSelectedAgent(agent)
        }}
        onClose={() => setShowAgentPicker(false)}
        renderIcon={(agent) => <AgentIcon agentId={agent.id} size={18} />}
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
  },
  letterIcon: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  letterIconText: {
    fontWeight: '700'
  },

  // Picker sub-modal styles
  pickerHeader: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  pickerTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  pickerGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  pickerSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  pickerList: {
    flexGrow: 0
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  pickerItemPressed: {
    backgroundColor: colors.bgRaised
  },
  pickerItemText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  pickerItemTextSelected: {
    fontWeight: '600'
  }
})
