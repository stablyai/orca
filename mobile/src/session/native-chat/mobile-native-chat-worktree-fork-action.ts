import { AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session/agent-session-create-capabilities'
import type { ActionSheetAction } from '../../components/ActionSheetModal'
import type { MobileSessionController } from '../use-mobile-session-controller'
import { requestMobileWorktreeFork } from './mobile-native-chat-worktree-fork-requests'

type Translate = (key: string, fallback: string) => string

/** "Fork into New Worktree" for the open chat; null where it is not a chat or the host can't. */
export function mobileWorktreeForkAction(
  controller: Pick<
    MobileSessionController,
    'hostCapabilities' | 'isFloatingWorkspaceRoute' | 'connState'
  >,
  tab: { type: string } | null | undefined,
  t: Translate,
  onDismiss?: () => void
): ActionSheetAction | null {
  if (
    tab?.type !== 'agent-session' ||
    controller.isFloatingWorkspaceRoute ||
    !controller.hostCapabilities?.includes(AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY)
  ) {
    return null
  }
  return {
    id: 'forkIntoWorktree',
    label: t('chat.fork.worktree.menu', 'Fork into New Worktree'),
    hint: t('chat.fork.worktree.menuHint', 'A new worktree with a copy of this chat'),
    disabled: controller.connState !== 'connected',
    closeBeforePress: true,
    onPress: () => {
      onDismiss?.()
      requestMobileWorktreeFork()
    }
  }
}
