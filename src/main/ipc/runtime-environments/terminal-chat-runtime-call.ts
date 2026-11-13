import type { RuntimeEnvironmentCall } from './requests/runtime-environment-call'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { mapTerminalChatExpiry } from '../../../shared/terminal/input/terminal-chat-prompt-budget'
import { readRuntimeElapsedClock } from '../../runtime/hosts/runtime-elapsed-clock'
import {
  assertTerminalChatCallCurrent,
  terminalChatCallBudget,
  type TerminalChatCallBudget
} from './terminal-chat-call-deadline'

class UnsupportedChatExpiry extends Error {}

/** Selection and the final synchronous check belong to the socket that sends this input. */
export function selectTerminalChatRuntimeCall(
  call: RuntimeEnvironmentCall,
  budget: TerminalChatCallBudget = terminalChatCallBudget(call)!
): RuntimeEnvironmentCall {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this selector receives the same Chat call parsed into its budget.
  const params = call.params as { chatPrompt: unknown }
  const { prompt } = budget
  const assertCurrent = (): void => {
    call.signal?.throwIfAborted()
    assertTerminalChatCallCurrent(budget)
  }
  assertCurrent()
  return {
    ...call,
    requestSelection: {
      paramsForStatus: (raw) => {
        assertCurrent()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads capability metadata; clock mapping validates the expiry sample before dispatch.
        const status = raw as RuntimeStatus
        if (!status.capabilities?.includes(TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY)) {
          throw new UnsupportedChatExpiry()
        }
        const receipt = readRuntimeElapsedClock()
        if (!receipt) {
          throw new Error('Chat input clock unavailable')
        }
        const expiry = mapTerminalChatExpiry(
          status.runtimeId,
          status.elapsedClockMs!,
          prompt.expiry!.expiresAtMs,
          receipt.upper
        )
        return { ...params, chatPrompt: { ...prompt, expiry } }
      },
      onDispatch: assertCurrent
    },
    prepareRequest: (request) => {
      assertCurrent()
      const prepared = call.prepareRequest?.(request) ?? request
      assertCurrent()
      return prepared
    }
  }
}

export function unsupportedTerminalChatResponse(
  error: unknown,
  runtimeId: string
): RuntimeRpcResponse<unknown> | null {
  return error instanceof UnsupportedChatExpiry
    ? {
        id: 'terminal.send',
        ok: true,
        _meta: { runtimeId },
        result: {
          send: {
            handle: '',
            accepted: false,
            bytesWritten: 0,
            chatPromptNotDispatched: 'unsupported'
          }
        }
      }
    : null
}
