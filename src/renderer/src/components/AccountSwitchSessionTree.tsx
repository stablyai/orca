import { formatAgentTypeLabel } from '@/lib/agent-status'
import { Folder, GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import type { AccountSwitchSession } from '@/lib/agent-account-switch-sessions'
import { isAgentPaneMidTurn } from './terminal-pane/pane-account-restart-readiness'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '../store'
import { ResumeTreeCount, ResumeTreeRow } from './NativeChatResumeTreeRow'
import {
  resumeSelectionState,
  toggleResumeSelection
} from './native-chat-resume-on-restart-grouping'
import { moveInTree } from './native-chat-resume-tree-keys'

type SessionTreeProps = {
  agent: AccountRestartAgent
  selected: ReadonlySet<string>
  onToggle: (ptyId: string, checked: boolean) => void
}

/**
 * The running agent sessions a switch can restart, grouped by workspace: the native-chat resume
 * dialog's tree rows, so both read the same.
 */
export function AccountSwitchSessionTree({
  agent,
  sessions,
  selected,
  onToggle
}: SessionTreeProps & { sessions: readonly AccountSwitchSession[] }): React.JSX.Element {
  const ptyIds = sessions.map((session) => session.ptyId)
  const all = resumeSelectionState(ptyIds, selected)
  const selectAllLabel = translate('accounts.switchSessions.selectAll', 'Select all')
  return (
    <div
      role="tree"
      tabIndex={0}
      aria-label={translate('accounts.switchSessions.listLabel', '{{agent}} sessions to restart', {
        agent: formatAgentTypeLabel(agent)
      })}
      className="max-h-64 min-h-0 overflow-y-auto scrollbar-sleek rounded-md bg-worktree-sidebar p-1.5 pb-2"
      onKeyDown={moveInTree}
    >
      <div className="mb-1 border-b border-worktree-sidebar-border pb-0.5">
        <ResumeTreeRow
          depth={0}
          name={selectAllLabel}
          checked={all.checked}
          disabled={false}
          onCheckedChange={() => toggleResumeSelection(ptyIds, all, onToggle)}
          checkboxLabel={translate(
            'accounts.switchSessions.selectAllSessions',
            'Select all sessions'
          )}
        >
          <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
            {selectAllLabel}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
            {translate(
              'accounts.switchSessions.selectedCount',
              '{{selected}} of {{total}} selected',
              { selected: all.selectedCount, total: all.total }
            )}
          </span>
        </ResumeTreeRow>
      </div>
      {groupByWorkspace(sessions).map(([worktreeId, group]) => (
        <WorkspaceGroup
          key={worktreeId}
          agent={agent}
          worktreeId={worktreeId}
          sessions={group}
          selected={selected}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

function groupByWorkspace(
  sessions: readonly AccountSwitchSession[]
): [string, AccountSwitchSession[]][] {
  const groups = new Map<string, AccountSwitchSession[]>()
  for (const session of sessions) {
    groups.set(session.worktreeId, [...(groups.get(session.worktreeId) ?? []), session])
  }
  return [...groups]
}

function WorkspaceGroup({
  agent,
  worktreeId,
  sessions,
  selected,
  onToggle
}: SessionTreeProps & {
  worktreeId: string
  sessions: readonly AccountSwitchSession[]
}): React.JSX.Element {
  const worktree = useAppStore((store) => store.getKnownWorktreeById(worktreeId))
  const name = (worktree && resolveWorktreeDisplayName(worktree)) || worktreeId
  const branch = worktree ? resolveWorktreeBranchLabel(worktree) : ''
  const KindGlyph = branch ? GitBranch : Folder
  const ptyIds = sessions.map((session) => session.ptyId)
  const selection = resumeSelectionState(ptyIds, selected)
  return (
    <>
      <ResumeTreeRow
        depth={0}
        name={name}
        checked={selection.checked}
        disabled={false}
        onCheckedChange={() => toggleResumeSelection(ptyIds, selection, onToggle)}
        checkboxLabel={translate(
          'accounts.switchSessions.selectWorkspace',
          'Select all sessions in {{workspace}}',
          { workspace: name }
        )}
      >
        <KindGlyph className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{name}</span>
        {branch && branch !== name && (
          <span className="min-w-0 shrink-2 truncate text-[11px] text-muted-foreground">
            {branch}
          </span>
        )}
        <ResumeTreeCount selectedCount={selection.selectedCount} total={selection.total} />
      </ResumeTreeRow>
      {sessions.map((session) => (
        <SessionRow
          key={session.ptyId}
          agent={agent}
          session={session}
          checked={selected.has(session.ptyId)}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}

function SessionRow({
  agent,
  session,
  checked,
  onToggle
}: {
  agent: AccountRestartAgent
  session: AccountSwitchSession
  checked: boolean
  onToggle: (ptyId: string, checked: boolean) => void
}): React.JSX.Element {
  const paneKey = session.leafId ? makePaneKey(session.tabId, session.leafId) : null
  const tabTitle = useAppStore((store) => {
    const tab = store.tabsByWorktree[session.worktreeId]?.find(
      (candidate) => candidate.id === session.tabId
    )
    return tab?.customTitle || tab?.title || ''
  })
  const lastPrompt = useAppStore((store) =>
    paneKey ? store.agentStatusByPaneKey[paneKey]?.prompt?.trim() : undefined
  )
  const busy = useAppStore((store) => (paneKey ? isAgentPaneMidTurn(store, paneKey, agent) : false))
  const agentLabel = formatAgentTypeLabel(agent)
  const title =
    lastPrompt ||
    tabTitle ||
    translate('accounts.switchSessions.session', '{{agent}} session', { agent: agentLabel })
  return (
    <ResumeTreeRow
      depth={1}
      compact
      name={title}
      checked={checked}
      disabled={false}
      onCheckedChange={(next) => onToggle(session.ptyId, next)}
      checkboxLabel={title}
    >
      <span role="img" aria-label={agentLabel} className="inline-flex shrink-0">
        <AgentIcon agent={agent} size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-foreground/90" title={title}>
        {title}
      </span>
      {lastPrompt && tabTitle && (
        <span className="min-w-0 max-w-28 shrink-0 truncate text-[11px] text-muted-foreground">
          {tabTitle}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {busy
          ? translate('accounts.switchSessions.busy', 'Working')
          : translate('accounts.switchSessions.idle', 'Idle')}
      </span>
    </ResumeTreeRow>
  )
}
