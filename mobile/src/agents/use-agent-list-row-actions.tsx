import { ArrowUpRight, Copy, Eye, EyeOff, Folder, X } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { TransientToast, useTransientToast } from '../components/TransientToast'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClipboardWriter } from '../platform/clipboard'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import type { HostProfile } from '../host-catalog/host-profile'
import type { AgentActivityChange, AgentListRow } from './agent-list-rows'
import type { AgentListRowHandlers } from './MobileAgentListRows'
import type { AgentActivityFailure } from './use-agent-activity-writes'

/**
 * Tap opens the agent's tab and marks it read; long-press offers it, its workspace, its title and
 * the desktop's read and clear. Shared by Feed and Agents.
 */
export function useAgentListRowActions(
  toastBottomInset: number,
  hosts: readonly HostProfile[],
  applyActivity: (
    rows: readonly AgentListRow[],
    change: AgentActivityChange
  ) => Promise<AgentActivityFailure[]>
) {
  const t = useMobileTranslation()
  const openMobileSession = useOpenMobileSession()
  const clipboard = useClipboardWriter()
  const { message, showToast } = useTransientToast()
  const [target, setTarget] = useState<AgentListRow | null>(null)

  const open = useCallback(
    (row: AgentListRow, withPane: boolean) =>
      openMobileSession({
        hostId: row.hostId,
        worktreeId: row.entry.worktreeId,
        name: row.entry.workspaceName,
        ...(withPane ? { paneKey: row.entry.agent.paneKey } : {})
      }),
    [openMobileSession]
  )
  const change = useCallback(
    (rows: readonly AgentListRow[], next: AgentActivityChange) => {
      if (rows.length === 0) {
        return
      }
      void applyActivity(rows, next).then((failures) => {
        const failure = failures[0]
        if (!failure) {
          return
        }
        const desktop = hosts.find((host) => host.id === failure.hostId)?.name
        showToast(
          failure.needsDesktopWindow && desktop
            ? t('agents.activity.needsWindow', 'Couldn’t update. Open Orca on {{desktop}}.', {
                desktop
              })
            : t('agents.activity.failed', 'Couldn’t update the agent list.')
        )
      })
    },
    [applyActivity, hosts, showToast, t]
  )
  const handlers = useMemo<AgentListRowHandlers>(
    () => ({
      onOpen: (row) => {
        // Like desktop opening a pane; a refusal here isn't worth interrupting the open.
        if (row.unread) {
          void applyActivity([row], { unread: false })
        }
        open(row, true)
      },
      onLongPress: setTarget,
      // Only rows the desktop gave a verdict for; the phone never invents read state.
      onSetRead: (rows, read) =>
        change(
          rows.filter((row) => row.unread !== undefined),
          { unread: !read }
        ),
      onClear: (rows) =>
        change(
          rows.filter((row) => row.clearable),
          { cleared: true }
        )
    }),
    [applyActivity, change, open]
  )

  const title = target?.title
  const offlineHint = target?.offline
    ? t('agents.actions.offlineHint', 'Its desktop is offline.')
    : undefined
  const actions = (row: AgentListRow): ActionSheetAction[] => [
    {
      id: 'open',
      label: t('agents.actions.open', 'Open'),
      icon: ArrowUpRight,
      disabled: row.offline,
      hint: offlineHint,
      closeBeforePress: true,
      onPress: () => handlers.onOpen(row)
    },
    {
      id: 'workspace',
      label: t('agents.actions.goToWorkspace', 'Go to workspace'),
      icon: Folder,
      disabled: row.offline,
      hint: offlineHint,
      closeBeforePress: true,
      onPress: () => open(row, false)
    },
    ...(row.unread === undefined
      ? []
      : [
          {
            id: 'read',
            label: row.unread
              ? t('agents.actions.markRead', 'Mark as read')
              : t('agents.actions.markUnread', 'Mark as unread'),
            icon: row.unread ? Eye : EyeOff,
            onPress: () => handlers.onSetRead([row], row.unread === true)
          }
        ]),
    {
      id: 'copy-title',
      label: t('agents.actions.copyTitle', 'Copy title'),
      icon: Copy,
      closeBeforePress: true,
      onPress: () => {
        void clipboard.writeText(title ?? '').then(
          () => showToast(t('agents.actions.copied', 'Copied')),
          () => Alert.alert(t('agents.actions.copyFailed', 'Couldn’t copy the title'))
        )
      }
    },
    ...(row.clearable
      ? [
          {
            id: 'clear',
            label: t('agents.actions.clear', 'Clear from list'),
            icon: X,
            onPress: () => handlers.onClear([row])
          }
        ]
      : [])
  ]
  const sheet = (
    <>
      <ActionSheetModal
        visible={target !== null}
        title={title}
        message={target?.entry.workspaceName}
        actions={target ? actions(target) : []}
        onClose={() => setTarget(null)}
      />
      <TransientToast message={message} bottomInset={toastBottomInset} />
    </>
  )
  return { handlers, sheet }
}
