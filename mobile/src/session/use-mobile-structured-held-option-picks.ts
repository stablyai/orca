import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AgentSessionOptionResult } from '../../../src/shared/agent-session/agent-session-wire'
import { acceptedStructuredSessionSelectionOutcome } from '../../../src/shared/agent-session/options/structured-agent-session-options-write-owner'
import {
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/agent-session/options/structured-agent-session-options'
import type { StructuredSessionSelectionController } from '../../../src/shared/agent-session/options/structured-agent-session-selection-operations'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatSessionOptionLabel
} from '../../../src/shared/native-chat/input/native-chat-session-option-labels'
import { translate } from '../i18n/mobile-i18n'
import { mobileSessionOptionSummaryValue } from './native-chat/input/mobile-native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat/input/native-chat-session-option-copy'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'

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

/** Picks made before the chat attaches wait on the controller and go out when its fence lands. */
export function useMobileStructuredHeldOptionPicks(args: {
  controller: StructuredSessionSelectionController
  mutate: MobileStructuredAgentMutate
  fence: number | null
  acceptsPicks: boolean
  isCurrentContext: () => boolean
  readOptionSnapshot: () => SessionOptionDescriptor[]
  onOptionError?: (message: string) => void
}) {
  const { controller, mutate, fence, acceptsPicks, isCurrentContext } = args
  const sendPicks = (isCurrent: () => boolean, held: boolean) => {
    controller.flush(async (pick) => {
      // A queued pick never retargets a replacement runtime.
      if (!isCurrent()) {
        return { kind: 'superseded' }
      }
      const result = await mutate<AgentSessionOptionResult>(
        'agentSession.setOption',
        'agentSession.setOption',
        { key: pick.key, value: pick.value },
        // A held pick's refusal names the kept value instead of the host's message.
        held ? () => false : undefined
      )
      return result.status === 'accepted'
        ? acceptedStructuredSessionSelectionOutcome(pick, result.value.options)
        : result.status === 'unknown'
          ? { kind: 'unknown' }
          : { kind: 'refused' }
    })
  }
  const latest = useRef({ sendPicks, args })
  useLayoutEffect(() => {
    latest.current = { sendPicks, args }
  })
  // Passive, so the option state's context has caught up with the new fence before it sends.
  useEffect(() => {
    if (fence !== null && acceptsPicks) {
      latest.current.sendPicks(isCurrentContext, true)
    }
  }, [fence, acceptsPicks, isCurrentContext])

  const holdUntilAttach = (
    id: string,
    encoded: string,
    view: StructuredAgentSessionOptionState,
    existingChat: boolean
  ) => {
    const pick = structuredAgentSessionOptionPicks(view, { [id]: encoded }, existingChat)[0]
    const operation = controller.issue(
      id,
      encoded,
      pick?.modelId ?? null,
      undefined,
      undefined,
      pick?.adoptModelAsLaunchDefault === false ? false : undefined
    )
    const shown = (): SessionOptionDescriptor | undefined =>
      latest.current.args.readOptionSnapshot().find((row) => row.id === id)
    const picked = pickLabel(shown())
    return operation.result.then((outcome) => {
      const kept = pickLabel(shown())
      if (outcome.kind === 'refused' && picked && kept) {
        latest.current.args.onOptionError?.(
          translate(
            'chat.sessionOptionPickers.heldPickRefused',
            "{{picked}} isn't available in this chat. Kept {{kept}}.",
            { picked, kept }
          )
        )
      }
      return outcome
    })
  }

  return {
    sendPicks,
    holdUntilAttach,
    heldPick:
      acceptsPicks &&
      fence === null &&
      controller.pending().some((operation) => !operation.transmitted)
  }
}
