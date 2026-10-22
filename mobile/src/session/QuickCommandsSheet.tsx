import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, View, Text, Pressable, StyleSheet } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import type { RpcClient } from '../transport/rpc-client'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import {
  getQuickCommandPreview,
  MAX_QUICK_COMMANDS,
  quickCommandMatchesRepo
} from '../terminal/quick-commands'
import { useQuickCommands } from './use-quick-commands'
import { QuickCommandEditorForm } from './QuickCommandEditorForm'
import { QuickCommandAgentPicker, QuickCommandsList } from './QuickCommandsList'
import {
  createEmptyQuickCommandDraft,
  draftToQuickCommand,
  quickCommandToDraft,
  type QuickCommandDraft
} from './quick-command-draft'

type Props = {
  visible: boolean
  onClose: () => void
  client: RpcClient | null
  repoId: string | null
  repoName: string | null
  /** The host's agent-prompt cap. */
  agentPromptMaxLength: number | null
  onLaunch: (command: TerminalQuickCommand) => boolean
}

type SheetView = 'list' | 'editor' | 'agent'

export function QuickCommandsSheet({
  visible,
  onClose,
  client,
  repoId,
  repoName,
  agentPromptMaxLength,
  onLaunch
}: Props) {
  const { commands, loading, ready, error, persist } = useQuickCommands({
    client,
    enabled: visible
  })
  const [view, setView] = useState<SheetView>('list')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<QuickCommandDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const saveOwnerRef = useRef<symbol | null>(null)
  const draftRevisionRef = useRef(0)
  const editorGenerationRef = useRef(0)

  const previousSurface = useRef({ visible, client, repoId })
  useLayoutEffect(() => {
    const contextChanged =
      previousSurface.current.client !== client || previousSurface.current.repoId !== repoId
    if (visible !== previousSurface.current.visible || contextChanged) {
      draftRevisionRef.current += 1
      editorGenerationRef.current += 1
      previousSurface.current = { visible, client, repoId }
      if (contextChanged) {
        saveOwnerRef.current = null
        setSaving(false)
      }
      if (visible || contextChanged) {
        setView('list')
        setQuery('')
        setDraft(null)
      }
    }
  }, [visible, client, repoId])

  // Why: prompt bodies can total megabytes. Lowercase them once per settings
  // update instead of allocating the same search text on every keystroke.
  const searchableCommands = useMemo(() => {
    return commands
      .filter((command) => quickCommandMatchesRepo(command, repoId))
      .map((command) => ({
        command,
        searchText: `${command.label} ${getQuickCommandPreview(command)}`.toLowerCase()
      }))
  }, [commands, repoId])

  const visibleCommands = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    return searchableCommands
      .filter((entry) => !trimmed || entry.searchText.includes(trimmed))
      .map((entry) => entry.command)
  }, [query, searchableCommands])

  const repoCommands = visibleCommands.filter((command) => command.scope?.type === 'repo')
  const globalCommands = visibleCommands.filter((command) => command.scope?.type !== 'repo')

  const openEditor = (command?: TerminalQuickCommand) => {
    // Why: the host rejects full-list updates above this cap; existing rows
    // must remain editable/deletable when creation is no longer possible.
    if (!command && commands.length >= MAX_QUICK_COMMANDS) {
      return
    }
    draftRevisionRef.current += 1
    editorGenerationRef.current += 1
    setDraft(
      command
        ? quickCommandToDraft(command)
        : createEmptyQuickCommandDraft(repoId ? { type: 'repo', repoId } : { type: 'global' })
    )
    setView('editor')
  }

  const handleLaunch = (command: TerminalQuickCommand) => {
    if (onLaunch(command)) {
      onClose()
    }
  }

  const handleDelete = (command: TerminalQuickCommand) => {
    // Why: quick commands sync with desktop, so an accidental one-tap delete
    // removes shared data rather than only dismissing a local row.
    Alert.alert(
      `Delete "${command.label || 'Untitled'}"?`,
      'This quick command will be removed from your saved list.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void persist({ type: 'delete', id: command.id })
          }
        }
      ]
    )
  }

  const handleSave = async () => {
    if (!draft || saveOwnerRef.current !== null) {
      return
    }
    const built = draftToQuickCommand(draft, agentPromptMaxLength)
    if (!built) {
      return
    }
    // Why: state cannot lock out a second tap until React commits the disabled UI.
    const saveOwner = Symbol()
    saveOwnerRef.current = saveOwner
    setSaving(true)
    const savedRevision = draftRevisionRef.current
    const savedEditor = editorGenerationRef.current
    try {
      const ok = await persist({ type: 'upsert', command: built })
      if (ok && draftRevisionRef.current === savedRevision) {
        setView('list')
        setDraft(null)
      } else if (ok && editorGenerationRef.current === savedEditor) {
        setDraft((current) => (current ? { ...current, id: built.id } : current))
      }
    } finally {
      if (saveOwnerRef.current === saveOwner) {
        saveOwnerRef.current = null
        setSaving(false)
      }
    }
  }

  const title =
    view === 'editor'
      ? draft?.id
        ? 'Edit Quick Command'
        : 'Add Quick Command'
      : view === 'agent'
        ? 'Choose Agent'
        : 'Quick Commands'

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        {view === 'list' ? (
          <View style={styles.backSpacer} />
        ) : (
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            onPress={() => {
              draftRevisionRef.current += 1
              setView(view === 'agent' ? 'editor' : 'list')
            }}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ChevronLeft size={18} color={colors.textSecondary} />
          </Pressable>
        )}
        <Text style={styles.title}>{title}</Text>
        <View style={styles.backSpacer} />
      </View>

      {view === 'editor' && draft ? (
        <View style={styles.editorDesc}>
          <Text style={styles.descText}>
            Save terminal commands or agent prompts for quick access.
          </Text>
        </View>
      ) : null}

      {view === 'list' ? (
        <QuickCommandsList
          repoCommands={repoCommands}
          globalCommands={globalCommands}
          totalCount={searchableCommands.length}
          query={query}
          loading={loading}
          disabled={!ready}
          canAdd={commands.length < MAX_QUICK_COMMANDS}
          error={error}
          onQueryChange={setQuery}
          onLaunch={handleLaunch}
          onEdit={openEditor}
          onDelete={handleDelete}
          onAdd={() => openEditor()}
        />
      ) : null}

      {view === 'editor' && draft ? (
        <QuickCommandEditorForm
          draft={draft}
          mode={draft.id ? 'edit' : 'add'}
          saving={saving || !ready}
          error={error}
          repoId={repoId}
          repoName={repoName}
          agentPromptMaxLength={agentPromptMaxLength}
          onChange={(patch) => {
            draftRevisionRef.current += 1
            setDraft((current) => (current ? { ...current, ...patch } : current))
          }}
          onOpenAgentPicker={() => {
            draftRevisionRef.current += 1
            setView('agent')
          }}
          onCancel={() => {
            draftRevisionRef.current += 1
            setView('list')
            setDraft(null)
          }}
          onSave={() => void handleSave()}
        />
      ) : null}

      {view === 'agent' && draft ? (
        <QuickCommandAgentPicker
          selected={draft.agent}
          onSelect={(agent) => {
            draftRevisionRef.current += 1
            setDraft((current) => (current ? { ...current, agent } : current))
            setView('editor')
          }}
        />
      ) : null}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: spacing.sm },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center'
  },
  backSpacer: { width: 30 },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center'
  },
  pressed: { backgroundColor: colors.bgRaised },
  editorDesc: { paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  descText: { fontSize: 12, color: colors.textMuted }
})
