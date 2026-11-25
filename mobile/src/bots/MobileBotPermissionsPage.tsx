import type { ReactNode } from 'react'
import {
  AGENT_CHAT_PERMISSION_MODES,
  type AgentChatPermissionMode
} from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModes } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-support'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ChoiceRows } from '../host-screen/workspace-options/workspace-option-rows'
import { SettingsNote } from '../settings/settings-screen-frame'
import type { SheetBot } from './bot-sheet-operations'
import { botPermissionSetting } from './MobileBotSettingsRoot'
import { mobilePermissionModeCopy } from './mobile-permission-mode-copy'

/** The bot's starting permission; null picks "Same as chats". */
export function MobileBotPermissionsPage(props: {
  bot: SheetBot
  disabled: boolean
  banner: ReactNode
  onBack: { label: string; onPress: () => void }
  onPick: (permissionMode: AgentChatPermissionMode | null) => void
}) {
  const t = useMobileTranslation()
  const { bot } = props
  const modes = agentChatPermissionModes(bot.agent)?.modes ?? AGENT_CHAT_PERMISSION_MODES
  const permissionChoices = [
    {
      id: 'inherit',
      label: t('bots.settings.sameAsChats', 'Same as chats'),
      description: t('bots.settings.sameAsChatsDetail', 'Uses your chat permission setting.')
    },
    ...modes.map((mode) => ({ id: mode, ...mobilePermissionModeCopy(bot.agent, mode, t) }))
  ]
  return (
    <>
      <SheetHeader title={t('bots.settings.permissions', 'Permissions')} onBack={props.onBack} />
      {props.banner}
      <ChoiceRows
        choices={permissionChoices}
        selected={botPermissionSetting(bot).mode ?? 'inherit'}
        disabled={props.disabled}
        onSelect={(mode) => {
          if (mode === 'inherit' || modes.some((value) => value === mode)) {
            props.onPick(mode === 'inherit' ? null : modes.find((value) => value === mode)!)
          }
        }}
      />
      <SettingsNote>
        {t(
          'bots.settings.permissionsDetail',
          'The starting permission for new sessions. Anything beyond it asks in the session.'
        )}
      </SettingsNote>
    </>
  )
}
