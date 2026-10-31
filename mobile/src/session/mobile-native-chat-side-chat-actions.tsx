import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { agentChatPermissionModes } from '../../../src/shared/agent-chat-permission-mode'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { CornerDownRight, Eye, GitFork } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSessionController } from './use-mobile-session-controller'

export function getMobileSideChatActions(args: {
  controller: Pick<MobileSessionController, 'agentSessionHostSupport' | 'handleOpenSideChat'>
  tab: Parameters<MobileSessionController['handleOpenSideChat']>[0] | null
  onChoosePermission: (
    tab: NonNullable<Parameters<MobileSessionController['handleOpenSideChat']>[0]>
  ) => void
  onDismiss: () => void
}): ActionSheetAction[] {
  const { tab, controller } = args
  if (!tab?.sideChatSupported || !controller.agentSessionHostSupport?.sideChat) {
    return []
  }
  return [
    {
      label: translate('session.sideChat.new', 'New side chat'),
      icon: CornerDownRight,
      closeBeforePress: true,
      onPress: () => args.onChoosePermission(tab)
    }
  ]
}

export function MobileSideChatPermissionSheet({
  controller,
  source,
  onClose
}: {
  controller: Pick<MobileSessionController, 'agentSessionHostSupport' | 'handleOpenSideChat'>
  source: Parameters<MobileSessionController['handleOpenSideChat']>[0] | null
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const choose = (permission: 'inherit' | 'read-only') => {
    if (source) {
      void controller.handleOpenSideChat(source, '', [], permission)
    }
  }
  return (
    <ActionSheetModal
      visible={source != null}
      title={t('session.sideChat.new', 'New side chat')}
      onClose={onClose}
      actions={[
        {
          label: t('session.sideChat.readOnly', 'Read only'),
          icon: Eye,
          hint: t(
            'session.sideChat.readOnlyDescription',
            'Uses a read-only sandbox without permission escalation'
          ),
          disabled:
            !controller.agentSessionHostSupport?.readOnlySideChat ||
            !agentChatPermissionModes(source?.agent ?? '')?.modes.includes('read-only'),
          onPress: () => choose('read-only')
        },
        {
          label: t('session.sideChat.inheritPermissions', 'Use main chat permissions'),
          icon: GitFork,
          hint: t(
            'session.sideChat.inheritDescription',
            'Starts with the main chat’s permissions; later changes are independent'
          ),
          onPress: () => choose('inherit')
        }
      ]}
    />
  )
}
