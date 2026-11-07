import { useContext, useMemo } from 'react'
import { queuedMessageCardLine } from '../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileQueuedMessageCard } from '../../mobile-structured-queued-message-cards'
import type { MobileNativeChatOfflineQueue as Queue } from '../composer/use-mobile-native-chat-offline-sends'
import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import { MobileNativeChatNoticeContext } from '../../mobile-native-chat-notice-context'

const PAUSED = { reason: 'failed' } as const

/** Messages sent while the desktop was out, drawn as today's queued box: they go when it's back. */
export function MobileNativeChatOfflineQueue({
  queue
}: {
  queue: Queue
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const { hostName } = useContext(MobileNativeChatNoticeContext)
  const { ready } = queue
  // A message on its way leaves the box; it comes back paused only if it didn't go.
  const sends = useMemo(() => queue.sends.filter((send) => !send.sending), [queue.sends])
  const { offline } = queue.composerLock
  const cards = useMemo(
    () =>
      sends.map((send, position): MobileQueuedMessageCard => {
        const behindPaused = sends.slice(0, position).some((ahead) => ahead.paused)
        const images = send.images.map((image) => ({
          type: 'image-ref' as const,
          path: image.path
        }))
        const line = queuedMessageCardLine({ text: send.text, images })
        const caption =
          send.paused === 'failed'
            ? t('chat.offlineQueue.failed', "Couldn't send — tap Send to retry")
            : send.paused === 'closed'
              ? t('chat.offlineQueue.closed', 'Not sent before Orca closed')
              : offline
                ? hostName
                  ? t('chat.offlineQueue.waitingFor', 'Sends when {{host}} is back', {
                      host: hostName
                    })
                  : t('chat.offlineQueue.waiting', 'Sends when the desktop is back')
                : behindPaused
                  ? t('chat.offlineQueue.behind', 'Waiting — a message ahead needs attention')
                  : null
        return {
          messageId: send.id,
          position,
          text: send.text,
          ...(images.length > 0 ? { images } : {}),
          state: 'waiting',
          hold: send.paused ? 'paused' : 'turn',
          // Its own Send can't reach the desktop yet.
          ...(ready ? {} : { waitsForAgent: true as const }),
          // A goal can't be taken back into the composer as a goal, so it offers no Edit.
          ...(send.goal ? { command: true as const } : {}),
          line: line.trim() ? line : send.files.map((file) => file.name).join(', '),
          needsAttention: send.paused === 'failed',
          caption
        }
      }),
    [hostName, offline, ready, sends, t]
  )
  if (cards.length === 0) {
    return null
  }
  return (
    <MobileNativeChatQueuedMessages
      cards={cards}
      onSend={queue.sendNow}
      onDelete={(id) => queue.remove([id])}
      onClearAll={queue.remove}
      clearable
      onEdit={queue.edit}
      pause={sends.some((send) => send.paused) ? PAUSED : null}
      onResume={queue.resume}
    />
  )
}
