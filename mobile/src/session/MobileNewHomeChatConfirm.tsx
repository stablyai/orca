import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'

/** The desktop's confirm before New Home Chat replaces the conversation the bot carries. */
export function MobileNewHomeChatConfirm({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'routeBot' | 'confirmingHomeChat' | 'setConfirmingHomeChat' | 'startNewHomeChat'
  >
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const bot = controller.routeBot?.bot
  if (!bot) {
    return null
  }
  return (
    <ConfirmModal
      visible={controller.confirmingHomeChat}
      title={t('bots.newHomeChat.title', 'Start a new Home Chat?')}
      message={t(
        'bots.newHomeChat.description',
        '{{name}} keeps its soul and memory, but not this conversation.',
        { name: bot.name }
      )}
      confirmLabel={t('bots.newHomeChat.action', 'New Home Chat')}
      onConfirm={() => controller.startNewHomeChat(bot.id)}
      onCancel={() => controller.setConfirmingHomeChat(false)}
    />
  )
}
