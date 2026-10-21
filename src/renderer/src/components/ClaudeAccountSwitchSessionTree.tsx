import { Folder, GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import {
  isClaudePaneMidTurn,
  type ClaudeSessionMoveCandidate
} from '@/lib/claude-session-account-move'
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
  selected: ReadonlySet<string>
  onToggle: (ptyId: string, checked: boolean) => void
}

/**
 * The running Claude sessions a switch can restart, grouped by workspace: the native-chat resume
 * dialog's tree rows, so both read the same.
 */
export function ClaudeAccountSwitchSessionTree({
  sessions,
  selected,
  onToggle
}: SessionTreeProps & { sessions: readonly ClaudeSessionMoveCandidate[] }): React.JSX.Element {
  const ptyIds = sessions.map((session) => session.ptyId)
  const all = resumeSelectionState(ptyIds, selected)
  const selectAllLabel = translate('accounts.claude.switchSessions.selectAll', 'Select all')
  return (
    <div
      role="tree"
      tabIndex={0}
      aria-label={translate(
        'accounts.claude.switchSessions.listLabel',
        'Claude sessions to restart'
      )}
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
            'accounts.claude.switchSessions.selectAllSessions',
            'Select all sessions'
          )}
        >
          <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
            {selectAllLabel}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
            {translate(
              'accounts.claude.switchSessions.selectedCount',
              '{{selected}} of {{total}} selected',
              { selected: all.selectedCount, total: all.total }
            )}
          </span>
        </ResumeTreeRow>
      </div>
      {groupByWorkspace(sessions).map(([worktreeId, group]) => (
        <WorkspaceGroup
          key={worktreeId}
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
  sessions: readonly ClaudeSessionMoveCandidate[]
): [string, ClaudeSessionMoveCandidate[]][] {
  const groups = new Map<string, ClaudeSessionMoveCandidate[]>()
  for (const session of sessions) {
    groups.set(session.worktreeId, [...(groups.get(session.worktreeId) ?? []), session])
  }
  return [...groups]
}

function WorkspaceGroup({
  worktreeId,
  sessions,
  selected,
  onToggle
}: SessionTreeProps & {
  worktreeId: string
  sessions: readonly ClaudeSessionMoveCandidate[]
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
          'accounts.claude.switchSessions.selectWorkspace',
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
          session={session}
          checked={selected.has(session.ptyId)}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}

function SessionRow({
  session,
  checked,
  onToggle
}: {
  session: ClaudeSessionMoveCandidate
  checked: boolean
  onToggle: (ptyId: string, checked: boolean) => void
}): React.JSX.Element {
  const paneKey = makePaneKey(session.tabId, session.leafId)
  const tabTitle = useAppStore((store) => {
    const tab = store.tabsByWorktree[session.worktreeId]?.find(
      (candidate) => candidate.id === session.tabId
    )
    return tab?.customTitle || tab?.title || ''
  })
  const lastPrompt = useAppStore((store) => store.agentStatusByPaneKey[paneKey]?.prompt?.trim())
  const busy = useAppStore((store) => isClaudePaneMidTurn(store, paneKey))
  const title =
    lastPrompt || tabTitle || translate('accounts.claude.switchSessions.session', 'Claude session')
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
      <span role="img" aria-label={formatAgentTypeLabel('claude')} className="inline-flex shrink-0">
        <AgentIcon agent="claude" size={13} />
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
          ? translate('accounts.claude.switchSessions.busy', 'Working')
          : translate('accounts.claude.switchSessions.idle', 'Idle')}
      </span>
    </ResumeTreeRow>
  )
}
