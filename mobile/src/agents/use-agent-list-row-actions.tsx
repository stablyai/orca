import { ArrowUpRight, Copy, Folder } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { TransientToast, useTransientToast } from '../components/TransientToast'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClipboardWriter } from '../platform/clipboard'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import type { AgentListRow } from './agent-list-model'
import { agentListTitle } from './agent-list-row-text'
import type { AgentListRowHandlers } from './MobileAgentListRows'

/** Tap opens the agent's tab; long-press offers it, its workspace and its title. Shared by Feed and Agents. */
export function useAgentListRowActions(toastBottomInset: number) {
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
  const handlers = useMemo<AgentListRowHandlers>(
    () => ({ onOpen: (row) => open(row, true), onLongPress: setTarget }),
    [open]
  )

  const title = target ? agentListTitle(target.entry.agent) : undefined
  const offlineHint = target?.offline
    ? t('agents.actions.offlineHint', 'Its desktop is offline.')
    : undefined
  const sheet = (
    <>
      <ActionSheetModal
        visible={target !== null}
        title={title}
        message={target?.entry.workspaceName}
        actions={
          target
            ? [
                {
                  id: 'open',
                  label: t('agents.actions.open', 'Open'),
                  icon: ArrowUpRight,
                  disabled: target.offline,
                  hint: offlineHint,
                  closeBeforePress: true,
                  onPress: () => open(target, true)
                },
                {
                  id: 'workspace',
                  label: t('agents.actions.goToWorkspace', 'Go to workspace'),
                  icon: Folder,
                  disabled: target.offline,
                  hint: offlineHint,
                  closeBeforePress: true,
                  onPress: () => open(target, false)
                },
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
                }
              ]
            : []
        }
        onClose={() => setTarget(null)}
      />
      <TransientToast message={message} bottomInset={toastBottomInset} />
    </>
  )
  return { handlers, sheet }
}
