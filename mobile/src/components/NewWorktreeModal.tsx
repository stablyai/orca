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
import { getSuggestedCreatureName } from './worktree-name-suggestion'

type Repo = {
  id: string
  displayName: string
  path: string
}

type AgentOption = {
  id: string
  label: string
  faviconDomain?: string
}

// Why: matches the AGENT_CATALOG ordering and faviconDomain values from
// src/renderer/src/lib/agent-catalog.tsx so mobile uses the same icon sources.
const AGENT_OPTIONS: AgentOption[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'GitHub Copilot', faviconDomain: 'github.com' },
  { id: 'opencode', label: 'OpenCode', faviconDomain: 'opencode.ai' },
  { id: 'pi', label: 'Pi' },
  { id: 'gemini', label: 'Gemini', faviconDomain: 'gemini.google.com' },
  { id: 'aider', label: 'Aider' },
  { id: 'goose', label: 'Goose', faviconDomain: 'goose-docs.ai' },
  { id: 'amp', label: 'Amp', faviconDomain: 'ampcode.com' },
  { id: 'kilo', label: 'Kilocode', faviconDomain: 'kilo.ai' },
  { id: 'kiro', label: 'Kiro', faviconDomain: 'kiro.dev' },
  { id: 'crush', label: 'Charm', faviconDomain: 'charm.sh' },
  { id: 'aug', label: 'Auggie', faviconDomain: 'augmentcode.com' },
  { id: 'cline', label: 'Cline', faviconDomain: 'cline.bot' },
  { id: 'codebuff', label: 'Codebuff', faviconDomain: 'codebuff.com' },
  { id: 'continue', label: 'Continue', faviconDomain: 'continue.dev' },
  { id: 'cursor', label: 'Cursor', faviconDomain: 'cursor.com' },
  { id: 'droid', label: 'Droid', faviconDomain: 'factory.ai' },
  { id: 'kimi', label: 'Kimi', faviconDomain: 'moonshot.cn' },
  { id: 'mistral-vibe', label: 'Mistral Vibe', faviconDomain: 'mistral.ai' },
  { id: 'qwen-code', label: 'Qwen Code', faviconDomain: 'qwenlm.github.io' },
  { id: 'rovo', label: 'Rovo Dev', faviconDomain: 'atlassian.com' },
  { id: 'hermes', label: 'Hermes', faviconDomain: 'nousresearch.com' }
]

const BLANK_TERMINAL: AgentOption = { id: '__blank__', label: 'Blank Terminal' }
const ALL_AGENTS = [...AGENT_OPTIONS, BLANK_TERMINAL]

// Why: mirrors launchCmd from src/shared/tui-agent-config.ts so terminal.create
// gets the correct binary name for each agent.
const AGENT_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  opencode: 'opencode',
  pi: 'pi',
  gemini: 'gemini',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro',
  crush: 'crush',
  aug: 'auggie',
  cline: 'cline',
  codebuff: 'codebuff',
  continue: 'continue',
  cursor: 'cursor-agent',
  droid: 'droid',
  kimi: 'kimi',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovo',
  hermes: 'hermes'
}

// ── Agent icons ─────────────────────────────────────────────────────
// SVG paths sourced from the desktop codebase:
//   Claude & OpenAI: src/renderer/src/components/status-bar/icons.tsx
//   Pi & Aider: src/renderer/src/lib/agent-catalog.tsx
// Agents with a faviconDomain use Google's favicon service (same as desktop).

function ClaudeIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        fill="#D97757"
        fillRule="nonzero"
      />
    </Svg>
  )
}

function OpenAIIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
        fill={colors.textPrimary}
        fillRule="evenodd"
      />
    </Svg>
  )
}

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
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [setupCommand, setSetupCommand] = useState<string | null>(null)
  const [setupSource, setSetupSource] = useState<string | null>(null)
  const [runSetup, setRunSetup] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  // Why: matches the desktop UI — the input shows a generic "Workspace name"
  // placeholder, not the suggested creature. The creature name is only used
  // as a server-bound fallback when the user submits with a blank field, so
  // it's recomputed lazily inside handleCreate() to stay fresh against
  // existingWorktreePaths at submission time.

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
    setRunSetup(true)
    setError('')
    setCreating(false)
    setShowRepoPicker(false)
    setShowAgentPicker(false)
    setSelectedAgent(AGENT_OPTIONS[0]!)
    setLoading(true)

    void (async () => {
      try {
        const response = await client.sendRequest('repo.list')
        if (stale) return
        if (response.ok) {
          const result = (response as RpcSuccess).result as { repos: Repo[] }
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
    if (!client || !selectedRepo) {
      setSetupCommand(null)
      setSetupSource(null)
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
          const result = (response as RpcSuccess).result as {
            hooks: { scripts: { setup?: string } } | null
            source: string | null
            setupRunPolicy: string
          }
          const cmd = result.hooks?.scripts.setup ?? null
          setSetupCommand(cmd)
          setSetupSource(result.source)
          setRunSetup(result.setupRunPolicy !== 'skip-by-default')
        }
      } catch {
        if (!stale) {
          setSetupCommand(null)
          setSetupSource(null)
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [client, selectedRepo])

  async function handleCreate() {
    if (!client || !selectedRepo) return
    setCreating(true)
    setError('')

    try {
      const command =
        selectedAgent.id !== '__blank__' ? AGENT_COMMANDS[selectedAgent.id] : undefined

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

      let lastError: string | null = null
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidateName = candidateFor(attempt)
        const params: Record<string, unknown> = {
          repo: `id:${selectedRepo.id}`,
          startupCommand: command,
          setupDecision: runSetup ? 'inherit' : 'skip',
          name: candidateName
        }
        if (note.trim()) params.comment = note.trim()

        const response = await client.sendRequest('worktree.create', params)
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

  const canCreate = selectedRepo != null && !creating

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
              <Pressable style={styles.fieldButton} onPress={() => setShowAgentPicker(true)}>
                <AgentIcon agentId={selectedAgent.id} size={16} />
                <Text style={styles.fieldButtonText} numberOfLines={1}>
                  {selectedAgent.label}
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
                  <Text style={styles.createText}>Create Workspace</Text>
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
        items={ALL_AGENTS}
        selectedId={selectedAgent.id}
        onSelect={(agent) => setSelectedAgent(agent)}
        onClose={() => setShowAgentPicker(false)}
        renderIcon={(agent) => <AgentIcon agentId={agent.id} size={18} />}
      />
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
