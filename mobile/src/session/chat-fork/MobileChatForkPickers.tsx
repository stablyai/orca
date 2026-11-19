import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { PickerModal, type PickerOption } from '../../components/sheets/PickerModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { ChatForkPicks, ChatForkSelection, ChatForkWorkspace } from './chat-fork-selection'
import type { ChatForkSurface } from '../../../../src/shared/native-chat/chat-fork-path'
import type { ChatForkRecapScope } from '../../../../src/shared/agent-session/context/chat-fork-recap'
import type { ChatForkHostRow } from './use-chat-fork-hosts'
import type { ChatForkWorkspaceRow } from './use-chat-fork-target'

export type ChatForkPickerView = 'host' | 'workspace' | 'agent' | 'runAs' | 'openAs' | 'context'

type Translate = ReturnType<typeof useMobileTranslation>

/** A host's line under its name: why it can't take the fork, when it can't. */
export function chatForkHostNote(host: ChatForkHostRow, t: Translate): string | undefined {
  switch (host.status) {
    case 'offline':
      return t('chat.fork.sheet.hostOffline', 'Not connected')
    case 'checking':
      return t('chat.fork.sheet.hostChecking', 'Checking…')
    case 'needs-update':
      return t('chat.fork.sheet.hostNeedsUpdate', 'Update Orca on this host to fork chats onto it')
    case 'ready':
      return host.current ? t('chat.fork.sheet.thisHost', 'This chat’s host') : host.subtitle
  }
}

export function chatForkWorkspaceLabel(workspace: ChatForkWorkspace | null, t: Translate): string {
  if (!workspace) {
    return t('chat.fork.sheet.chooseWorkspace', 'Choose a workspace')
  }
  return workspace.kind === 'this'
    ? t('chat.fork.sheet.thisWorktree', 'This worktree, in a new tab')
    : workspace.kind === 'new'
      ? t('chat.fork.sheet.newWorktree', 'A new worktree')
      : workspace.name
}

export function chatForkRunAsLabel(runAs: ChatForkSelection['runAs'], t: Translate): string {
  return runAs === 'subagent'
    ? t('chat.fork.sheet.runSubagent', 'Background subagent with a task')
    : t('chat.fork.sheet.runOpen', 'Open it')
}

export function chatForkOpenAsLabel(openAs: ChatForkSurface | null, t: Translate): string {
  return openAs === 'chat'
    ? t('chat.fork.sheet.openAsChat', 'Chat')
    : openAs === 'terminal'
      ? t('chat.fork.sheet.openAsTerminal', 'Terminal (CLI)')
      : t('chat.fork.sheet.openAsNone', 'This agent can’t open on this host')
}

/** Why a kind isn't offered, when one isn't. */
export function chatForkOpenAsNote(selection: ChatForkSelection, t: Translate): string | undefined {
  if (!selection.surfaces.terminal && selection.surfaces.chat) {
    return t(
      'chat.fork.sheet.terminalUnavailable',
      'Update Orca on this host to fork into a terminal'
    )
  }
  if (!selection.surfaces.chat && selection.surfaces.terminal) {
    return t('chat.fork.sheet.chatUnavailable', 'This agent doesn’t open as a chat on this host')
  }
  return undefined
}

export function chatForkRecapScopeLabel(scope: ChatForkRecapScope, t: Translate): string {
  return scope === 'current'
    ? t('chat.fork.sheet.contextCurrent', 'Current context (since the last compact or clear)')
    : t('chat.fork.sheet.contextHistory', 'Full history up to here')
}

/** The sheet's pickers; one shows at a time, in place of the form. */
export function MobileChatForkPickers(props: {
  view: ChatForkPickerView | null
  hosts: readonly ChatForkHostRow[]
  workspaces: readonly ChatForkWorkspaceRow[]
  selection: ChatForkSelection
  onPick: (picks: ChatForkPicks) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { selection, view } = props
  const hostOptions: PickerOption[] = props.hosts.map((host) => ({
    value: host.hostId,
    label: host.label,
    subtitle: chatForkHostNote(host, t),
    disabled: host.status !== 'ready'
  }))
  const workspaceOptions: PickerOption[] = [
    ...(selection.sameHost
      ? [{ value: 'this', label: chatForkWorkspaceLabel({ kind: 'this' }, t) }]
      : []),
    ...(selection.newWorktreeOffered
      ? [{ value: 'new', label: chatForkWorkspaceLabel({ kind: 'new' }, t) }]
      : []),
    ...props.workspaces.map((row) => ({
      value: `existing:${row.worktreeId}`,
      label: row.name,
      subtitle: row.detail || undefined
    }))
  ]
  const agentOptions: PickerOption[] = selection.agentChoices.map((choice) => ({
    value: choice.agent,
    label: TUI_AGENT_DISPLAY_NAMES[choice.agent],
    disabled: !choice.enabled,
    subtitle: choice.enabled
      ? undefined
      : t(
          'chat.fork.sheet.agentUnavailable',
          'This chat can’t be forked into this agent on this host'
        ),
    renderIcon: () => <MobileAgentIcon agentId={choice.agent} size={20} />
  }))
  const runAsOptions: PickerOption<ChatForkSelection['runAs']>[] = [
    { value: 'open', label: chatForkRunAsLabel('open', t) },
    {
      value: 'subagent',
      label: chatForkRunAsLabel('subagent', t),
      subtitle: t(
        'chat.fork.sheet.runSubagentHint',
        'Works in its own worktree and reports back to this chat'
      )
    }
  ]
  const openAsOptions: PickerOption[] = (['chat', 'terminal'] as const).map((surface) => ({
    value: surface,
    label: chatForkOpenAsLabel(surface, t),
    disabled: !selection.surfaces[surface]
  }))
  const contextOptions: PickerOption<ChatForkRecapScope>[] = (['history', 'current'] as const).map(
    (scope) => ({ value: scope, label: chatForkRecapScopeLabel(scope, t) })
  )
  const workspaceValue = !selection.workspace
    ? ''
    : selection.workspace.kind === 'existing'
      ? `existing:${selection.workspace.worktreeId}`
      : selection.workspace.kind
  return (
    <>
      <PickerModal
        visible={view === 'host'}
        title={t('chat.fork.sheet.host', 'Host')}
        options={hostOptions}
        selected={selection.hostId}
        onSelect={(hostId) => props.onPick({ hostId })}
        onClose={props.onClose}
      />
      <PickerModal
        visible={view === 'workspace'}
        title={t('chat.fork.sheet.workspace', 'Workspace')}
        options={workspaceOptions}
        selected={workspaceValue}
        searchable
        onSelect={(value) => props.onPick({ workspace: workspaceFromValue(value, props) })}
        onClose={props.onClose}
      />
      <PickerModal
        visible={view === 'agent'}
        title={t('chat.fork.sheet.agent', 'Agent')}
        options={agentOptions}
        selected={selection.agent ?? ''}
        onSelect={(value) => {
          const agent = selection.agentChoices.find((choice) => choice.agent === value)?.agent
          if (agent) {
            props.onPick({ agent })
          }
        }}
        onClose={props.onClose}
      />
      <PickerModal
        visible={view === 'runAs'}
        title={t('chat.fork.sheet.runAs', 'Run as')}
        options={runAsOptions}
        selected={selection.runAs}
        onSelect={(runAs) => props.onPick({ runAs })}
        onClose={props.onClose}
      />
      <PickerModal
        visible={view === 'openAs'}
        title={t('chat.fork.sheet.openAs', 'Open as')}
        options={openAsOptions}
        selected={selection.openAs ?? ''}
        onSelect={(value) => {
          const openAs = openAsOptions.find((option) => option.value === value)?.value
          if (openAs === 'chat' || openAs === 'terminal') {
            props.onPick({ openAs })
          }
        }}
        onClose={props.onClose}
      />
      <PickerModal
        visible={view === 'context'}
        title={t('chat.fork.sheet.context', 'Context')}
        options={contextOptions}
        selected={selection.recapScope}
        onSelect={(recapScope) => props.onPick({ recapScope })}
        onClose={props.onClose}
      />
    </>
  )
}

function workspaceFromValue(
  value: string,
  props: { workspaces: readonly ChatForkWorkspaceRow[]; selection: ChatForkSelection }
): ChatForkWorkspace | undefined {
  if (value === 'this' || value === 'new') {
    return { kind: value }
  }
  const row = props.workspaces.find((candidate) => `existing:${candidate.worktreeId}` === value)
  return row
    ? {
        kind: 'existing',
        hostId: props.selection.hostId,
        worktreeId: row.worktreeId,
        name: row.name
      }
    : undefined
}
