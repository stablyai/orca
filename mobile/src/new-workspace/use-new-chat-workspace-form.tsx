import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ListGroup, ListRow, SectionHeader, LIST_LEADING_INSET } from '../components/list/ListGroup'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { PickerListDrawer } from '../components/sheets/PickerListDrawer'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { TextField } from '../components/composer-input/TextField'
import { AutoHeight } from '../components/motion/AutoHeight'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { optionalSettingsRead } from '../settings/mobile-settings-read-operations'
import { useNewWorkspaceExecutionTarget } from './creation/runtime/use-new-workspace-execution-target'
import { useNewWorkspaceAgentSelection } from './creation/runtime/use-new-workspace-agent-selection'
import type { NewWorktreeRuntimeSettings } from './creation/runtime/new-worktree-agent-selection'
import type { NewWorktreeModalProps } from './creation/forms/new-worktree-modal-types'
import { newWorktreeFormStyles as styles } from './creation/forms/new-worktree-form-styles'
import { useNewWorktreeDrawerNavigation } from './creation/modal/use-new-worktree-drawer-navigation'
import { newChatWorkspaceSubmission } from './create-chat-workspace'
import { WorkspaceCreationTabs } from './WorkspaceCreationTabs'
import { durableDraftRowKey } from '../drafts/durable-draft-rows'
import { useDurableDraftField } from '../drafts/durable-draft-fields'

export function useNewChatWorkspaceForm(props: NewWorktreeModalProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [settings, setSettings] = useState<NewWorktreeRuntimeSettings | null>(null)
  const target = useNewWorkspaceExecutionTarget({
    client: props.client,
    connectionId: null,
    visible: props.visible
  })
  const agents = useNewWorkspaceAgentSelection({
    visible: props.visible,
    runtimeSettings: settings,
    detectedAgentIds: target.detectedAgentIds
  })
  const navigation = useNewWorktreeDrawerNavigation(props.visible)
  const [note, setNote] = useDurableDraftField(
    props.visible ? durableDraftRowKey('workspaceCreate', '', props.hostId ?? '') : null,
    'chatNote'
  )
  const [noteOptions, setNoteOptions] = useState<'closed' | 'open' | 'folded'>('closed')
  if (note && noteOptions === 'closed') {
    setNoteOptions('open')
  }
  const expanded = noteOptions === 'open'
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [locked, setLocked] = useState(false)
  const submission = useRef<ReturnType<typeof newChatWorkspaceSubmission> | null>(null)
  const inFlight = useRef(false)
  useEffect(() => {
    const client = props.client
    if (!props.visible || !client) {
      return
    }
    let stale = false
    void optionalSettingsRead
      .request(client)
      .then((reply) => {
        const read = optionalSettingsRead.interpret(reply)
        if (!stale && read.accepted && read.value && typeof read.value === 'object') {
          const value = read.value
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing agent selection resolves optional host settings.
          setSettings(value as NewWorktreeRuntimeSettings)
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [props.client, props.visible])
  async function create() {
    if (!props.client || inFlight.current) {
      return
    }
    inFlight.current = true
    setCreating(true)
    setLocked(true)
    setError('')
    submission.current ??= newChatWorkspaceSubmission()
    try {
      const result = await submission.current.create(props.client, {
        agent: agents.selectedAgent.id,
        note
      })
      if (result.savedNote !== null) {
        setNote((current) => (current.trim() === result.savedNote ? '' : current))
      }
      props.onClose()
      props.onCreated(result.worktreeId, result.name, result.warning)
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t('chats.createFailed', 'Could not create chat')
      )
    } finally {
      inFlight.current = false
      setCreating(false)
    }
  }
  function requestClose() {
    if (creating) {
      return
    }
    if (navigation.drawerView !== 'form') {
      navigation.transitionDrawer('form')
      return
    }
    props.onClose()
  }
  const title = t('chats.create', 'Create chat')
  return {
    interactive: navigation.formSheetInteractive,
    dismissible: !creating,
    requestClose,
    onClose: creating ? () => undefined : props.onClose,
    form: (
      <>
        <View style={styles.header}>
          <SheetHeader
            title={title}
            titleControl={
              props.onCreationKindChange ? (
                <WorkspaceCreationTabs
                  selected="chat"
                  onSelect={props.onCreationKindChange}
                  disabled={creating || locked}
                />
              ) : undefined
            }
            leading={{
              label: t('common.cancel', 'Cancel'),
              onPress: props.onClose,
              disabled: creating
            }}
          />
        </View>
        <SectionHeader title={t('components.newWorktreeFormSheet.agent', 'Agent')} />
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          <ListRow
            title={agents.selectedAgent.label}
            leading={<MobileAgentIcon agentId={agents.selectedAgent.id} size={20} />}
            navigates
            disabled={creating || locked}
            onPress={() => navigation.transitionDrawer('agent')}
          />
        </ListGroup>
        <SectionHeader
          title={t('components.newWorktreeFormSheet.options', 'Options')}
          expanded={expanded}
          onToggle={() => setNoteOptions(expanded ? 'folded' : 'open')}
        />
        <AutoHeight open={expanded}>
          <View style={styles.options}>
            <Text style={styles.fieldLabel}>
              {t('components.newWorktreeFormSheet.note', 'Note')}
            </Text>
            <TextField
              value={note}
              onChangeText={setNote}
              editable={!creating && !locked}
              placeholder={t('components.newWorktreeFormSheet.notePlaceholder', 'Write a note')}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </AutoHeight>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.footer}>
          <SheetPrimaryButton
            label={title}
            busy={creating}
            disabled={creating || !props.client}
            onPress={() => void create()}
          />
        </View>
      </>
    ),
    drawers: (
      <PickerListDrawer
        visible={props.visible && navigation.drawerView === 'agent'}
        title={t('components.newWorktreeFormSheet.agent', 'Agent')}
        items={agents.pickerAgentOptions}
        selectedId={agents.selectedAgent.id}
        onSelect={(agent) => {
          agents.setAgentOverridden(true)
          agents.setSelectedAgent(agent)
        }}
        onClose={() => navigation.transitionDrawer('form')}
        renderIcon={(agent) => <MobileAgentIcon agentId={agent.id} size={20} />}
      />
    )
  }
}
