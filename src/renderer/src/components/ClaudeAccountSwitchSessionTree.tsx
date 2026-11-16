import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { formatAgentTypeLabel } from '../../../shared/agent-status/presentation/agent-type-label'
import type { ClaudeAccountSwitchPromptSessions } from '@/lib/provider-accounts/claude-account-switch-sessions'
import {
  isClaudePaneMidTurn,
  type ClaudeSessionCantMoveReason,
  type ClaudeSessionMoveCandidate
} from '@/lib/agent-session/accounts/claude/claude-session-account-move'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/workspace/display/worktree-default-display-name'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '../store/index'
import { ResumeTreeRow } from './native-chat-recovery/tree/NativeChatResumeTreeRow'
import {
  resumeSelectionState,
  toggleResumeSelection
} from './native-chat-recovery/tree/native-chat-resume-on-restart-grouping'
import { moveInTree } from './native-chat-recovery/tree/native-chat-resume-tree-keys'

type SessionRowData = ClaudeSessionMoveCandidate & { reason?: string }

type SessionGroup = {
  key: string
  title: string
  sessions: SessionRowData[]
  /** Listed for information only: no checkboxes. */
  fixed?: true
}

type SessionTreeProps = {
  selected: ReadonlySet<string>
  onToggle: (ptyId: string, checked: boolean) => void
}

export function ClaudeAccountSwitchSessionTree({
  sessions,
  previousAccountLabel,
  selected,
  onToggle
}: SessionTreeProps & {
  sessions: ClaudeAccountSwitchPromptSessions
  previousAccountLabel: string
}): React.JSX.Element {
  const t = useTranslate()
  const groups = sessionGroups(sessions, previousAccountLabel, t)
  const treeRef = useRef<HTMLDivElement>(null)
  const pinnedIndex = useNextGroupBelowFold(treeRef, groups.length)
  return (
    <div
      ref={treeRef}
      role="tree"
      tabIndex={0}
      aria-label={t('accounts.claude.switchSessions.listLabel', 'Claude sessions to restart')}
      className="relative max-h-64 min-h-0 scroll-py-8 overflow-y-auto scrollbar-sleek rounded-md bg-worktree-sidebar p-1.5 pb-2"
      onKeyDown={moveInTree}
    >
      {groups.map((group, index) => (
        <Fragment key={group.key}>
          {/* Unstuck position of the header below, to find the next group under the fold. */}
          <div data-group-anchor aria-hidden="true" />
          <GroupHeader
            group={group}
            pinnedToBottom={index === pinnedIndex}
            selected={selected}
            onToggle={onToggle}
          />
          {groupByWorkspace(group.sessions).map(([worktreeId, workspaceSessions]) => (
            <Fragment key={worktreeId}>
              <WorkspaceRow worktreeId={worktreeId} fixed={group.fixed} />
              {workspaceSessions.map((session) => (
                <SessionRow
                  key={session.ptyId}
                  session={session}
                  fixed={group.fixed}
                  checked={selected.has(session.ptyId)}
                  onToggle={onToggle}
                />
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/** Pin only the first group header below the visible area, so that whole group is one click away. */
function useNextGroupBelowFold(
  treeRef: React.RefObject<HTMLDivElement | null>,
  groupCount: number
): number {
  const [pinned, setPinned] = useState(-1)
  useLayoutEffect(() => {
    const tree = treeRef.current
    if (!tree) {
      return
    }
    const update = (): void => {
      const viewBottom = tree.scrollTop + tree.clientHeight
      const anchors = [...tree.querySelectorAll<HTMLElement>('[data-group-anchor]')]
      // Why the header height: a header that is only partly visible still needs pinning.
      setPinned(
        anchors.findIndex(
          (anchor) => anchor.offsetTop + (anchor.nextElementSibling?.clientHeight ?? 0) > viewBottom
        )
      )
    }
    update()
    tree.addEventListener('scroll', update, { passive: true })
    return () => tree.removeEventListener('scroll', update)
  }, [treeRef, groupCount])
  return pinned
}

function sessionGroups(
  sessions: ClaudeAccountSwitchPromptSessions,
  previousAccountLabel: string,
  t: Translate = translate
): SessionGroup[] {
  const groups: SessionGroup[] = [
    {
      key: 'on-account',
      title: t('accounts.claude.switchSessions.groupOnAccount', 'Running on {{account}}', {
        account: previousAccountLabel
      }),
      sessions: sessions.onAccount
    },
    {
      key: 'elsewhere',
      title: t('accounts.claude.switchSessions.groupElsewhere', 'Not on {{account}}', {
        account: previousAccountLabel
      }),
      sessions: sessions.elsewhere.map((session) => ({ ...session, reason: session.accountLabel }))
    },
    {
      key: 'cant-move',
      title: t('accounts.claude.switchSessions.groupCantMove', "Can't move"),
      sessions: sessions.cantMove.map((session) => ({
        ...session,
        reason: cantMoveReasonLabel(session.reason, t)
      })),
      fixed: true
    }
  ]
  return groups.filter((group) => group.sessions.length > 0)
}

function cantMoveReasonLabel(
  reason: ClaudeSessionCantMoveReason,
  t: Translate = translate
): string {
  switch (reason) {
    case 'wsl-terminal':
      return t('accounts.claude.switchSessions.reasonWsl', 'WSL terminal')
    case 'own-folder':
      return t('accounts.claude.switchSessions.reasonOwnFolder', 'Uses your own Claude folder')
    case 'unknown-account':
      return t('accounts.claude.switchSessions.reasonUnknownAccount', 'Account unknown')
    case 'no-session':
      return t('accounts.claude.switchSessions.reasonNoSession', "Can't resume")
    case 'shared-session':
      return t('accounts.claude.switchSessions.reasonSharedSession', 'Also open in another pane')
  }
}

function groupByWorkspace(sessions: readonly SessionRowData[]): [string, SessionRowData[]][] {
  const groups = new Map<string, SessionRowData[]>()
  for (const session of sessions) {
    groups.set(session.worktreeId, [...(groups.get(session.worktreeId) ?? []), session])
  }
  return [...groups]
}

/** No checkbox, in the checkbox's column, so text lines up with rows that have one. */
const EMPTY_CHECKBOX_SLOT = <span aria-hidden="true" />

function GroupHeader({
  group,
  pinnedToBottom,
  selected,
  onToggle
}: SessionTreeProps & { group: SessionGroup; pinnedToBottom: boolean }): React.JSX.Element {
  const t = useTranslate()
  const ptyIds = group.sessions.map((session) => session.ptyId)
  const selection = resumeSelectionState(ptyIds, selected)
  return (
    <div
      data-pinned={pinnedToBottom}
      className="sticky -top-1.5 z-10 border-b border-worktree-sidebar-border bg-worktree-sidebar data-[pinned=true]:-bottom-2"
    >
      <ResumeTreeRow
        depth={0}
        name={group.title}
        checked={selection.checked}
        disabled={false}
        checkboxSlot={group.fixed ? EMPTY_CHECKBOX_SLOT : undefined}
        onCheckedChange={() => toggleResumeSelection(ptyIds, selection, onToggle)}
        checkboxLabel={t(
          'accounts.claude.switchSessions.selectGroup',
          'Select all sessions in {{group}}',
          { group: group.title }
        )}
      >
        <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">
          {group.title}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          ({group.sessions.length})
        </span>
      </ResumeTreeRow>
    </div>
  )
}

function WorkspaceRow({
  worktreeId,
  fixed
}: {
  worktreeId: string
  fixed?: true
}): React.JSX.Element {
  const worktree = useAppStore((store) => store.getKnownWorktreeById(worktreeId))
  const name = (worktree && resolveWorktreeDisplayName(worktree)) || worktreeId
  const branch = worktree ? resolveWorktreeBranchLabel(worktree) : ''
  const KindGlyph = branch ? GitBranch : Folder
  return (
    <ResumeTreeRow
      depth={1}
      name={name}
      checked={false}
      disabled
      checkboxSlot={EMPTY_CHECKBOX_SLOT}
      onCheckedChange={() => {}}
      checkboxLabel={name}
    >
      <KindGlyph className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span
        data-fixed={Boolean(fixed)}
        className="min-w-0 truncate text-[13px] font-medium text-foreground data-[fixed=true]:text-muted-foreground"
      >
        {name}
      </span>
      {branch && branch !== name && (
        <span className="min-w-0 shrink-2 truncate text-[11px] text-muted-foreground">
          {branch}
        </span>
      )}
    </ResumeTreeRow>
  )
}

function SessionRow({
  session,
  fixed,
  checked,
  onToggle
}: {
  session: SessionRowData
  fixed?: true
  checked: boolean
  onToggle: (ptyId: string, checked: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const paneKey = makePaneKey(session.tabId, session.leafId)
  const tabTitle = useAppStore((store) => {
    const tab = store.tabsByWorktree[session.worktreeId]?.find(
      (candidate) => candidate.id === session.tabId
    )
    return tab?.customTitle || tab?.title || ''
  })
  const lastPrompt = useAgentStatus(paneKey)?.prompt?.trim()
  const busy = useAppStore((store) => isClaudePaneMidTurn(store, paneKey))
  const title =
    lastPrompt || tabTitle || t('accounts.claude.switchSessions.session', 'Claude session')
  return (
    <ResumeTreeRow
      depth={2}
      compact
      name={title}
      checked={checked}
      disabled={false}
      checkboxSlot={fixed ? EMPTY_CHECKBOX_SLOT : undefined}
      onCheckedChange={(next) => onToggle(session.ptyId, next)}
      checkboxLabel={title}
    >
      <span role="img" aria-label={formatAgentTypeLabel('claude')} className="inline-flex shrink-0">
        <AgentIcon agent="claude" size={13} />
      </span>
      <span
        data-fixed={Boolean(fixed)}
        className="min-w-0 flex-1 truncate text-xs text-foreground/90 data-[fixed=true]:text-muted-foreground"
        title={title}
      >
        {title}
      </span>
      {lastPrompt && tabTitle && (
        <span className="min-w-0 max-w-28 shrink-0 truncate text-[11px] text-muted-foreground">
          {tabTitle}
        </span>
      )}
      <span className="max-w-40 shrink-0 truncate text-[11px] text-muted-foreground">
        {session.reason ??
          (busy
            ? t('accounts.claude.switchSessions.busy', 'Working')
            : t('accounts.claude.switchSessions.idle', 'Idle'))}
      </span>
    </ResumeTreeRow>
  )
}
