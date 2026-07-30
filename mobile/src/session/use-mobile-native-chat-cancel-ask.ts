import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'
import { t } from '@/i18n/mobile-i18n'

/** Sends the Escape that dismisses an ask/question card. Its own module for the
 *  same reason stop/permission/answer are: the controller owns composition, not
 *  the per-action write semantics. */
export function useMobileNativeChatCancelAsk(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  /** Drops any in-flight paced answer writes before the Escape lands. */
  cancelPending: () => void
  onSendError: (message: string) => void
}): () => Promise<boolean> {
  const { client, enabled, handleRef, deviceTokenRef, cancelPending, onSendError } = args
  return useCallback(async (): Promise<boolean> => {
    const handle = handleRef.current
    if (!client || !handle || !enabled) {
      onSendError(t('m.Z_x_TcE'))
      return false
    }
    cancelPending()
    // Escape never submits the composer, so no stale-input heal: it would consume
    // the marker still protecting the next real message.
    const outcome = await sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: handle,
      text: String.fromCharCode(27),
      enter: false,
      ...(deviceTokenRef.current
        ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
        : {})
    })
    if (outcome === 'unknown') {
      // Why: the Escape may have landed (ack lost / path cutover) — a definite
      // "not sent" would invite a second Escape into a changed prompt state.
      onSendError(t('m.chT2Z44'))
    } else if (outcome === 'rejected') {
      onSendError(t('m.htcCRsA'))
    }
    return outcome === 'accepted'
  }, [cancelPending, client, deviceTokenRef, enabled, handleRef, onSendError])
}
