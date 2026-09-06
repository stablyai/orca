import type { RoomMessage } from '../../../shared/rooms'
import type { RoomAttachmentManager } from './attachments'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'

export async function stageRoomDeliveryAttachments(input: {
  adapter: RoomHarnessAdapter
  binding: RoomHarnessBinding
  attachments: RoomAttachmentManager
  messages: RoomMessage[]
}): Promise<ReadonlyMap<string, string>> {
  const paths = new Map<string, string>()
  for (const message of input.messages) {
    for (const attachment of message.attachments) {
      if (paths.has(attachment.id)) {
        continue
      }
      await input.attachments.size(attachment.localPath)
      paths.set(
        attachment.id,
        await input.adapter.stageAttachment(input.binding, {
          id: attachment.id,
          fileName: attachment.fileName,
          localPath: attachment.localPath
        })
      )
    }
  }
  return paths
}
