import type { ReactNode } from 'react'
import { ArrowUpDown, Bot as BotIcon, Users } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import type { useMobileTranslation } from '../i18n/use-mobile-translation'

type Translate = ReturnType<typeof useMobileTranslation>

// Each choice opens another sheet or alert, so it runs once this menu's native modal has unmounted.

/** The Bots "+" menu, as the desktop's: New bot, and New group once this computer has two bots. */
export function botCreateMenuActions(input: {
  t: Translate
  /** The host's whole roster, not the search-filtered rows: search never changes who can join. */
  botCount: number
  /** The paired computer: groups are its bots' alone. */
  hostLabel: string
  onNewBot: () => void
  onNewGroup: () => void
  /** Only while the computer sorts its bots Manual, as the desktop drags only then. */
  onReorder: (() => void) | null
}): ActionSheetAction[] {
  const { t } = input
  return [
    {
      label: t('bots.section.newBot', 'New bot'),
      icon: BotIcon,
      closeBeforePress: true,
      onPress: input.onNewBot
    },
    {
      label: t('bots.groups.newGroup', 'New group'),
      icon: Users,
      // A group needs two bots to talk to each other.
      disabled: input.botCount < 2,
      ...(input.botCount < 2
        ? {
            hint: t('bots.groups.needsTwoBots', 'Needs 2 bots on {{host}}', {
              host: input.hostLabel
            })
          }
        : {}),
      closeBeforePress: true,
      onPress: input.onNewGroup
    },
    ...(input.onReorder
      ? [
          {
            label: t('bots.section.reorder', 'Reorder…'),
            icon: ArrowUpDown,
            closeBeforePress: true,
            onPress: input.onReorder
          }
        ]
      : [])
  ]
}

/** A group row's long-press menu, as the desktop's row menu; in the room, New thread leads it as on
 *  the desktop's + menu. */
export function botGroupMenuActions(input: {
  t: Translate
  newThread?: { renderIcon: () => ReactNode; disabled: boolean; onPress: () => void }
  onManageMembers: () => void
  onDelete: (() => void) | null
}): ActionSheetAction[] {
  const { t, newThread, onDelete } = input
  return [
    ...(newThread
      ? [
          {
            label: t('bots.groups.newThreadTab', 'New thread'),
            status: t('bots.groups.newThreadHint', 'starts fresh'),
            ...newThread
          }
        ]
      : []),
    {
      label: t('bots.groups.manageMembersMenu', 'Manage members…'),
      closeBeforePress: true,
      onPress: input.onManageMembers
    },
    ...(onDelete
      ? [
          {
            label: t('bots.groups.deleteGroupMenu', 'Delete group…'),
            destructive: true,
            closeBeforePress: true,
            onPress: onDelete
          }
        ]
      : [])
  ]
}
