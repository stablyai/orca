import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { TerminalQuickCommand } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-types'
import { terminalQuickCommandMatchesRepo as quickCommandMatchesRepo } from '../../../../src/shared/terminal/quick-commands/terminal-quick-commands'
import { searchTerminalQuickCommands } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-search'
import { useQuickCommands } from './use-quick-commands'
import { QuickCommandEditorForm } from './QuickCommandEditorForm'
import { QuickCommandAgentPicker, QuickCommandsList } from './QuickCommandsList'
import {
  createEmptyQuickCommandDraft,
  draftToQuickCommand,
  isQuickCommandDraftValid,
  quickCommandToDraft,
  type QuickCommandDraft
} from './quick-command-draft'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

type Props = {
  visible: boolean
  onClose: () => void
  client: RpcClient | null
  repoId: string | null
  repoName: string | null
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
  const t = useMobileTranslation()
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

  const scoped = useMemo(() => {
    const matching = commands.filter((command) => quickCommandMatchesRepo(command, repoId))
    return {
      count: matching.length,
      repo: matching.filter((command) => command.scope?.type === 'repo'),
      global: matching.filter((command) => command.scope?.type !== 'repo')
    }
  }, [commands, repoId])
  // Desktop's ranked search, run per section like its tab-bar menu.
  const repoCommands = useMemo(
    () => searchTerminalQuickCommands(scoped.repo, query),
    [scoped, query]
  )
  const globalCommands = useMemo(
    () => searchTerminalQuickCommands(scoped.global, query),
    [scoped, query]
  )

  const openEditor = (command?: TerminalQuickCommand) => {
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
      t('common.delete', 'Delete'),
      [
        command.label || t('session.quickCommandsSheet.untitled', 'Untitled'),
        t(
          'session.quickCommandsSheet.deleteConfirmMessage',
          'This quick command will be removed from your saved list.'
        )
      ].join('\n'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('common.delete', 'Delete'),
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
        ? t('session.quickCommandsSheet.editTitle', 'Edit Quick Command')
        : t('session.quickCommandsSheet.addTitle', 'Add Quick Command')
      : view === 'agent'
        ? t('session.quickCommandsSheet.chooseAgentTitle', 'Choose Agent')
        : t('session.quickCommandsSheet.title', 'Quick Commands')

  const backToList = () => {
    draftRevisionRef.current += 1
    setView('list')
    setDraft(null)
  }

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      {/* Validation scans the whole prompt, so a hidden sheet skips it. */}
      {visible && view === 'editor' && draft ? (
        <SheetHeader
          title={title}
          leading={{ label: t('common.cancel', 'Cancel'), onPress: backToList }}
          trailing={{
            label: draft.id ? t('common.save', 'Save') : t('session.quickCommandsSheet.add', 'Add'),
            onPress: () => void handleSave(),
            disabled: !isQuickCommandDraftValid(draft, agentPromptMaxLength) || !ready,
            busy: saving
          }}
        />
      ) : view === 'agent' ? (
        <SheetHeader
          title={title}
          onBack={{
            label: t('common.back', 'Back'),
            onPress: () => {
              draftRevisionRef.current += 1
              setView('editor')
            }
          }}
        />
      ) : (
        <SheetHeader title={title} />
      )}

      {view === 'list' ? (
        <QuickCommandsList
          repoCommands={repoCommands}
          globalCommands={globalCommands}
          totalCount={scoped.count}
          query={query}
          loading={loading}
          disabled={!ready}
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
