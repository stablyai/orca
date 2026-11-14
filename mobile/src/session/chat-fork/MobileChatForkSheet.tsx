import { useState } from 'react'
import { Text, View } from 'react-native'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { MobileAgentIcon } from '../../components/MobileAgentIcon'
import { newWorktreeFormStyles as styles } from '../../components/new-worktree-form-styles'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ChatForkRunTarget } from './chat-fork-run'
import {
  resolveChatForkSelection,
  type ChatForkPicks,
  type ChatForkPreset,
  type ChatForkSource
} from './chat-fork-selection'
import {
  chatForkHostNote,
  chatForkRunAsLabel,
  chatForkWorkspaceLabel,
  MobileChatForkPickers,
  type ChatForkPickerView
} from './MobileChatForkPickers'
import { useChatForkHosts } from './use-chat-fork-hosts'
import { useChatForkTargetAgents, useChatForkWorkspaceRows } from './use-chat-fork-target'

export type MobileChatForkSheetSource = ChatForkSource & {
  worktreeId: string
  client: RpcClient | null
  capabilities: readonly string[] | undefined
}

/** One Fork sheet: host, workspace, agent and how it runs, each with a default, so Fork works at once. */
export function MobileChatForkSheet(props: {
  visible: boolean
  preset: ChatForkPreset
  source: MobileChatForkSheetSource
  busy: boolean
  progress: string | null
  onConfirm: (target: ChatForkRunTarget) => void
  onClose: () => void
  onAfterClose: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { source } = props
  const [picks, setPicks] = useState<ChatForkPicks>({})
  const [view, setView] = useState<ChatForkPickerView | null>(null)
  const hosts = useChatForkHosts({
    currentHostId: source.hostId,
    currentClient: source.client,
    currentCapabilities: source.capabilities
  })
  const pickedHost = hosts.find((host) => host.hostId === picks.hostId)
  const targetHost = pickedHost ?? hosts[0]
  const targetClient = targetHost?.status === 'ready' ? targetHost.client : null
  const workspaces = useChatForkWorkspaceRows(
    targetClient,
    targetHost?.hostId ?? source.hostId,
    targetHost?.current === false ? null : source.worktreeId
  )
  const targetAgents = useChatForkTargetAgents(targetClient)
  const selection = resolveChatForkSelection({
    source,
    preset: props.preset,
    hosts,
    targetAgents,
    picks
  })
  const { agent, workspace } = selection
  const host = hosts.find((row) => row.hostId === selection.hostId)
  const pick = (next: ChatForkPicks): void =>
    setPicks((previous) => ({
      ...previous,
      ...next,
      // Picking a workspace other than a new worktree means the person wants to open it.
      ...(next.workspace && next.workspace.kind !== 'new' ? { runAs: 'open' as const } : {})
    }))
  const confirm = (): void => {
    if (!agent || !workspace || !selection.ready || props.busy) {
      return
    }
    props.onConfirm({
      hostId: selection.hostId,
      hostLabel: host?.label ?? selection.hostId,
      workspace,
      agent,
      runAs: selection.runAs
    })
  }
  const usageLimitNote =
    source.usageLimited && agent && agent !== source.agent
      ? t(
          'chat.fork.sheet.usageLimited',
          '{{agent}} is at its usage limit, so the fork starts with {{other}}, which gets a recap of this chat.',
          { agent: TUI_AGENT_DISPLAY_NAMES[source.agent], other: TUI_AGENT_DISPLAY_NAMES[agent] }
        )
      : null
  const recapNote =
    !usageLimitNote && agent && agent !== source.agent
      ? t('chat.fork.sheet.recapNote', '{{agent}} starts with a recap of this chat up to here.', {
          agent: TUI_AGENT_DISPLAY_NAMES[agent]
        })
      : null
  return (
    <>
      <BottomDrawer
        visible={props.visible && view === null}
        // A copy to another workspace can't be stopped; the sheet shows its progress until it ends.
        dismissible={!props.busy}
        onClose={props.onClose}
        onAfterClose={() => {
          if (!props.visible) {
            props.onAfterClose()
          }
        }}
      >
        <View style={styles.header}>
          <SheetHeader
            title={t('chat.fork.sheet.title', 'Fork chat')}
            leading={{
              label: t('common.cancel', 'Cancel'),
              onPress: props.onClose,
              disabled: props.busy
            }}
          />
        </View>
        <SectionHeader title={t('chat.fork.sheet.host', 'Host')} />
        <ListGroup>
          <ListRow
            title={host?.label ?? selection.hostId}
            subtitle={host ? chatForkHostNote(host, t) : undefined}
            navigates
            disabled={props.busy || hosts.length < 2}
            onPress={() => setView('host')}
          />
        </ListGroup>
        <SectionHeader title={t('chat.fork.sheet.workspace', 'Workspace')} />
        <ListGroup>
          <ListRow
            title={chatForkWorkspaceLabel(workspace, t)}
            navigates
            disabled={props.busy || selection.runAs === 'subagent'}
            onPress={() => setView('workspace')}
          />
        </ListGroup>
        <SectionHeader title={t('chat.fork.sheet.agent', 'Agent')} />
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          <ListRow
            title={
              agent
                ? TUI_AGENT_DISPLAY_NAMES[agent]
                : targetAgents === null
                  ? t('chat.fork.sheet.hostChecking', 'Checking…')
                  : t('chat.fork.sheet.noAgent', 'No agent on this host can take this fork')
            }
            leading={agent ? <MobileAgentIcon agentId={agent} size={20} /> : undefined}
            navigates
            disabled={props.busy}
            onPress={() => setView('agent')}
          />
        </ListGroup>
        {usageLimitNote || recapNote ? (
          <Text style={styles.notice}>{usageLimitNote ?? recapNote}</Text>
        ) : null}
        {selection.subagentOffered ? (
          <>
            <SectionHeader title={t('chat.fork.sheet.runAs', 'Run as')} />
            <ListGroup>
              <ListRow
                title={chatForkRunAsLabel(selection.runAs, t)}
                navigates
                disabled={props.busy}
                onPress={() => setView('runAs')}
              />
            </ListGroup>
          </>
        ) : null}
        {props.progress ? <Text style={styles.notice}>{props.progress}</Text> : null}
        <View style={styles.footer}>
          <SheetPrimaryButton
            label={t('chat.fork.sheet.fork', 'Fork')}
            busy={props.busy}
            disabled={!selection.ready}
            onPress={confirm}
          />
        </View>
      </BottomDrawer>
      <MobileChatForkPickers
        view={props.visible ? view : null}
        hosts={hosts}
        workspaces={workspaces}
        selection={selection}
        onPick={pick}
        onClose={() => setView(null)}
      />
    </>
  )
}
