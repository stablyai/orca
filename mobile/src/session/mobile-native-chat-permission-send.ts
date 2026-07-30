import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { t } from '@/i18n/mobile-i18n'

export function sendMobileNativeChatPermissionResponse(args: {
  client: RpcClient
  terminal: string
  deviceToken: string | null
  text: string
}): Promise<MobileNativeChatSendOutcome> {
  // Why: approval choices are already complete terminal control sequences;
  // appending Return changes both numbered choices and Escape denial.
  return sendMobileNativeChatMessageWithOutcome({
    client: args.client,
    terminal: args.terminal,
    text: args.text,
    enter: false,
    ...(args.deviceToken ? { mobileClient: { id: args.deviceToken, type: 'mobile' as const } } : {})
  })
}

export function useMobileNativeChatPermissionSend(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  onSendError: (message: string) => void
}): (text: string) => Promise<boolean> {
  return useCallback(
    async (text: string): Promise<boolean> => {
      const terminal = args.handleRef.current
      if (!args.client || !terminal || !args.enabled) {
        args.onSendError(t('m.6dxPsys'))
        return false
      }
      // No stale-input heal here (unlike the text/ask sends): a choice is an
      // `enter: false` key for an active overlay that swallows the clear, so it
      // would consume the marker still protecting the next real message.
      const outcome = await sendMobileNativeChatPermissionResponse({
        client: args.client,
        terminal,
        deviceToken: args.deviceTokenRef.current,
        text
      })
      if (outcome === 'unknown') {
        // Why: the response may have been delivered (ack lost / path cutover) —
        // a definite "not sent" would invite a double answer.
        args.onSendError(t('m.v7vfn5Q'))
      } else if (outcome === 'rejected') {
        args.onSendError(t('m.zGX7CcI'))
      }
      return outcome === 'accepted'
    },
    [args.client, args.deviceTokenRef, args.enabled, args.handleRef, args.onSendError]
  )
}
