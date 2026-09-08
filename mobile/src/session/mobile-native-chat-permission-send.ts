import { useCallback, type MutableRefObject } from 'react'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'

export function sendMobileNativeChatPermissionResponse(args: {
  operations: HostSessionNativeChatOperations
  target: HostSessionNativeChatTarget
  text: string
}): Promise<MobileNativeChatSendOutcome> {
  // Why: approval choices are already complete terminal control sequences;
  // appending Return changes both numbered choices and Escape denial.
  return args.operations.respond(args.target, args.text, false)
}

export function useMobileNativeChatPermissionSend(args: {
  operations: HostSessionNativeChatOperations | null
  targetRef: MutableRefObject<HostSessionNativeChatTarget | null>
  enabled: boolean
  onSendError: (message: string) => void
}): (text: string) => Promise<boolean> {
  return useCallback(
    async (text: string): Promise<boolean> => {
      const target = args.targetRef.current
      if (!args.operations || !target || !args.enabled) {
        args.onSendError('Response not sent (disconnected)')
        return false
      }
      const terminal = target.terminalId ?? target.sessionId
      // A choice keystroke must not interleave into a mid-flight composed write
      // (image paste, paced answer) on the same PTY.
      if (!acquireMobileNativeChatTerminalWrite(terminal)) {
        args.onSendError('Response not sent')
        return false
      }
      // No stale-input heal here (unlike the text/ask sends): a choice is an
      // `enter: false` key for an active overlay that swallows the clear, so it
      // would consume the marker still protecting the next real message.
      let outcome: MobileNativeChatSendOutcome
      try {
        outcome = await sendMobileNativeChatPermissionResponse({
          operations: args.operations,
          target,
          text
        })
      } finally {
        releaseMobileNativeChatTerminalWrite(terminal)
      }
      if (outcome === 'unknown') {
        // Why: the response may have been delivered (ack lost / path cutover) —
        // a definite "not sent" would invite a double answer.
        args.onSendError('Response unconfirmed — check chat before retrying')
      } else if (outcome === 'rejected') {
        args.onSendError('Response not sent')
      }
      return outcome === 'accepted'
    },
    [args.enabled, args.onSendError, args.operations, args.targetRef]
  )
}
