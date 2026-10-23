import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { SheetHeader } from '../components/ui/SheetHeader'
import { triggerError, triggerSuccess } from '../platform/haptics'
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

type SheetView = 'list' | 'editor' | 'agent' | 'confirm-delete'

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
  const [pendingDelete, setPendingDelete] = useState<TerminalQuickCommand | null>(null)
  const [deleting, setDeleting] = useState(false)
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
        setPendingDelete(null)
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

  // Why: quick commands sync with desktop, so a delete removes shared data; it confirms in the sheet
  // (React Native's Alert does nothing on the page).
  const handleDelete = (command: TerminalQuickCommand) => {
    setPendingDelete(command)
    setView('confirm-delete')
  }

  const confirmDelete = async () => {
    const command = pendingDelete
    if (!command || deleting) {
      return
    }
    setDeleting(true)
    try {
      const ok = await persist({ type: 'delete', id: command.id })
      if (ok) {
        triggerSuccess()
        setPendingDelete(null)
        setView('list')
      } else {
        triggerError()
      }
    } finally {
      setDeleting(false)
    }
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
        triggerSuccess()
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

  const backToList = () => {
    draftRevisionRef.current += 1
    setView('list')
    setDraft(null)
    setPendingDelete(null)
  }

  const header =
    view === 'editor' ? (
      <SheetHeader
        title={draft?.id ? 'Edit quick command' : 'New quick command'}
        leading={{ label: 'Cancel', onPress: backToList }}
      />
    ) : view === 'agent' ? (
      <SheetHeader
        title="Choose agent"
        leading={{
          label: 'Back',
          onPress: () => {
            draftRevisionRef.current += 1
            setView('editor')
          }
        }}
      />
    ) : view === 'confirm-delete' ? (
      <SheetHeader
        title="Delete quick command?"
        leading={{ label: 'Cancel', onPress: backToList }}
      />
    ) : (
      <SheetHeader title="Quick commands" onClose={onClose} />
    )

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>{header}</View>

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

      {view === 'confirm-delete' && pendingDelete ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmMessage}>
            {`“${pendingDelete.label || 'Untitled'}” will be removed from your saved list on every device.`}
          </Text>
          {error ? <Banner tone="error" message={error} /> : null}
          <View style={styles.confirmActions}>
            <Button
              label="Delete"
              variant="destructive"
              block
              busy={deleting}
              disabled={!ready}
              onPress={() => void confirmDelete()}
            />
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  // Why: pulls the header's text actions out to the sheet edge, as the shared sheet spec lays them.
  header: { marginHorizontal: -spacing.sm, marginTop: -spacing.xs },
  confirm: { gap: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  confirmMessage: {
    ...textStyles.callout,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg
  },
  confirmActions: { paddingHorizontal: spacing.xs }
})
