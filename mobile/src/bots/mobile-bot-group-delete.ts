import { Alert } from 'react-native'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { useMobileTranslation } from '../i18n/use-mobile-translation'
import { groupDelete } from './bot-group-operations'

/** Confirms, deletes the group on its host, then runs `onDeleted`. */
export function confirmMobileBotGroupDelete(input: {
  client: RpcClient
  group: Pick<BotGroup, 'id' | 'name'>
  t: ReturnType<typeof useMobileTranslation>
  onDeleted: () => void
  onError: (message: string) => void
}): void {
  const { client, group, t } = input
  Alert.alert(
    t('bots.groups.deleteTitle', 'Delete {{name}}?', { name: group.name }),
    t('bots.groups.deleteDescription', 'Its bots are not deleted.'),
    [
      { text: t('bots.groups.cancel', 'Cancel'), style: 'cancel' },
      {
        text: t('bots.groups.deleteConfirm', 'Delete group'),
        style: 'destructive',
        onPress: () => {
          void groupDelete
            .request(client, { groupId: group.id })
            .then((reply) => {
              groupDelete.interpret(reply)
              input.onDeleted()
            })
            .catch((error: unknown) => input.onError(String(error)))
        }
      }
    ]
  )
}
