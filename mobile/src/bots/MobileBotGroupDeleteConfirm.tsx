import { useState } from 'react'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupDelete } from './bot-group-operations'
import { closeMobileNativeChatTabDraft } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import { mobileBotGroupDraftKey } from './use-mobile-bot-group-draft'

/** Asks before deleting `group` on its host, drops its rooms' drafts, then runs `onDeleted`; a drawer,
 *  as the page has no alerts. */
export function MobileBotGroupDeleteConfirm({
  client,
  hostId,
  group,
  onClose,
  onDeleted,
  onError
}: {
  client: RpcClient
  hostId: string
  /** The group to ask about; null keeps the drawer closed. */
  group: Pick<BotGroup, 'id' | 'name' | 'threads'> | null
  onClose: () => void
  onDeleted: () => void
  onError: (message: string) => void
}) {
  const t = useMobileTranslation()
  // The name stays while the drawer slides away.
  const [asked, setAsked] = useState(group)
  if (group && group !== asked) {
    setAsked(group)
  }
  return (
    <ConfirmModal
      visible={group !== null}
      title={t('bots.groups.deleteTitle', 'Delete {{name}}?', { name: asked?.name ?? '' })}
      message={t('bots.groups.deleteDescription', 'Its bots are not deleted.')}
      confirmLabel={t('bots.groups.deleteConfirm', 'Delete group')}
      destructive
      onCancel={onClose}
      onConfirm={() => {
        if (!group) {
          return
        }
        void groupDelete
          .request(client, { groupId: group.id })
          .then((reply) => {
            groupDelete.interpret(reply)
            for (const room of [group.id, ...(group.threads ?? []).map((thread) => thread.id)]) {
              closeMobileNativeChatTabDraft(mobileBotGroupDraftKey(hostId, group.id, room))
            }
            onDeleted()
          })
          .catch((error: unknown) => onError(String(error)))
      }}
    />
  )
}
