import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AgentSessionOptionResult } from '../../../../../../src/shared/agent-session/agent-session-wire'
import { acceptedStructuredSessionSelectionOutcome } from '../../../../../../src/shared/agent-session/options/reconciliation/structured-agent-session-options-write-owner'
import type { StructuredSessionSelectionController } from '../../../../../../src/shared/agent-session/options/selection/structured-agent-session-selection-operations'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatSessionOptionLabel
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { translate } from '../../../../i18n/mobile-i18n'
import { mobileSessionOptionSummaryValue } from './mobile-native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import type { MobileStructuredAgentMutate } from '../../agent-session/use-mobile-structured-agent-mutation'

function pickLabel(descriptor: SessionOptionDescriptor | undefined): string | null {
  if (!descriptor) {
    return null
  }
  if (descriptor.category === 'model') {
    return nativeChatModelPillLabel(descriptor, say)
  }
  const value = mobileSessionOptionSummaryValue(descriptor)
  return descriptor.kind.type === 'boolean'
    ? `${nativeChatSessionOptionLabel(descriptor, say)} ${value}`
    : value
}

/** Sends picks; ones taken before the chat attached go when its fence lands and report a refusal themselves. */
export function useMobileStructuredHeldOptionPicks(args: {
  controller: StructuredSessionSelectionController
  mutate: MobileStructuredAgentMutate
  fence: number | null
  acceptsPicks: boolean
  isCurrentContext: () => boolean
  flushQueued: () => void
  readOptionSnapshot: () => SessionOptionDescriptor[]
  onOptionError?: (message: string) => void
}) {
  const { controller, mutate, fence, acceptsPicks, isCurrentContext } = args
  const sendPicks = (isCurrent: () => boolean, queued = false) => {
    controller.flush(async (pick) => {
      // A queued pick never retargets a replacement runtime.
      if (!isCurrent()) {
        return { kind: 'superseded' }
      }
      const shown = (): string | null =>
        pickLabel(latest.current.args.readOptionSnapshot().find((row) => row.id === pick.key))
      const picked = queued ? shown() : null
      const result = await mutate<AgentSessionOptionResult>(
        'agentSession.setOption',
        'agentSession.setOption',
        { key: pick.key, value: pick.value },
        // A queued pick's refusal names the kept value instead of the host's message.
        queued ? () => false : undefined
      )
      if (result.status === 'accepted') {
        return acceptedStructuredSessionSelectionOutcome(pick, result.value.options)
      }
      if (result.status === 'unknown') {
        return { kind: 'unknown' }
      }
      // The kept value shows once the refused pick has left the overlay.
      void pick.result.then((outcome) => {
        const kept = shown()
        // A chat left or a pick replaced meanwhile has nothing to report.
        if (outcome.kind === 'refused' && !controller.current(pick.key) && picked && kept) {
          latest.current.args.onOptionError?.(
            translate(
              'chat.sessionOptionPickers.heldPickRefused',
              "{{picked}} isn't available in this chat. Kept {{kept}}.",
              { picked, kept }
            )
          )
        }
      })
      return { kind: 'refused' }
    })
  }
  const latest = useRef({ args })
  useLayoutEffect(() => {
    latest.current = { args }
  })
  // Passive, so the option state's context has caught up with the new fence before it sends.
  useEffect(() => {
    if (fence !== null && acceptsPicks) {
      latest.current.args.flushQueued()
    }
  }, [fence, acceptsPicks, isCurrentContext])

  return {
    sendPicks,
    heldPick:
      acceptsPicks &&
      fence === null &&
      controller.pending().some((operation) => !operation.transmitted)
  }
}
