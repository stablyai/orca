import { useMemo, useRef, useState } from 'react'
import { Alert, View, Text, Pressable, StyleSheet } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import type { RpcClient } from '../transport/rpc-client'
import type { TerminalQuickCommand } from '../../../src/shared/types'
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
  onLaunch: (command: TerminalQuickCommand) => boolean
}

type SheetView = 'list' | 'editor' | 'agent'

export function QuickCommandsSheet({
  visible,
  onClose,
  client,
  repoId,
  repoName,
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
  const savingRef = useRef(false)

  const [wasVisible, setWasVisible] = useState(visible)
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (visible) {
      setView('list')
      setQuery('')
      setDraft(null)
    }
  }

  // Why: prompt bodies can total ~240 KB. Lowercase them once per settings
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
    if (!draft || savingRef.current) {
      return
    }
    const built = draftToQuickCommand(draft)
    if (!built) {
      return
    }
    // Why: state cannot lock out a second tap until React commits the disabled UI.
    savingRef.current = true
    setSaving(true)
    try {
      const ok = await persist({ type: 'upsert', command: built })
      if (ok) {
        setView('list')
        setDraft(null)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
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
            onPress={() => setView(view === 'agent' ? 'editor' : 'list')}
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
          onChange={(patch) =>
            setDraft((current) => (current ? { ...current, ...patch } : current))
          }
          onOpenAgentPicker={() => setView('agent')}
          onCancel={() => {
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
