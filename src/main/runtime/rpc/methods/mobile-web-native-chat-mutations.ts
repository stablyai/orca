import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { typeAgentTuiCommand } from '../../../../shared/agent-tui-command-typing'
import { AGENT_TUI_CLEAR_INPUT_LINE } from '../../../../shared/agent-tui-input-clear'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import { TerminalSend } from './terminal/unary-schemas'
import { MobileWebChatTarget, resolveMobileWebNativeChat } from './mobile-web-native-chat-binding'

const method = TERMINAL_SEND_METHODS.find((entry) => entry.name === 'terminal.send')
if (!method || isStreamingMethod(method)) {
  throw new Error('Missing terminal sender')
}
const sender = method
const Params = MobileWebChatTarget.extend({
  action: z.enum(['sendMessage', 'respond', 'stop', 'prepareCommit']),
  text: z
    .string()
    .max(64 * 1024)
    .optional(),
  enter: z.boolean().optional(),
  clearInputFirst: z.boolean().optional(),
  typeCommand: z.boolean().optional(),
  resolvedLaunchDraft: TerminalSend.shape.resolvedLaunchDraft,
  timeoutMs: z.number().int().min(1).max(15_000)
}).superRefine((params, context) => {
  if ((params.action === 'sendMessage' || params.action === 'respond') && !params.text) {
    context.addIssue({ code: 'custom', message: 'Missing chat input', path: ['text'] })
  }
})
type Outcome = 'accepted' | 'rejected' | 'unknown'

export const MOBILE_WEB_NATIVE_CHAT_MUTATION_METHOD = defineMethod({
  name: 'mobileWeb.nativeChat.mutate',
  params: Params,
  handler: async (params, context) => {
    if (!context.clientId) {
      throw new Error('Missing authenticated mobile client')
    }
    const deadline = Date.now() + params.timeoutMs
    const writable = () => !context.signal?.aborted && deadline - Date.now() >= 2_000
    // Resolved once: a per-keystroke re-resolve costs a full tab enumeration per character.
    const binding = await resolveMobileWebNativeChat(context, params)
    const write = async (
      text: string,
      enter: boolean,
      resolvedLaunchDraft?: z.infer<typeof TerminalSend>['resolvedLaunchDraft']
    ): Promise<Outcome> => {
      if (!writable()) {
        return 'rejected'
      }
      const input = TerminalSend.parse({
        terminal: binding.terminal,
        text,
        enter,
        resolvedLaunchDraft,
        client: { id: context.clientId, type: 'mobile' }
      })
      try {
        const result = (await sender.handler(input, context)) as {
          send?: { accepted?: boolean }
        } | null
        if (result?.send?.accepted === true) {
          return 'accepted'
        }
        return result?.send?.accepted === false ? 'rejected' : 'unknown'
      } catch {
        // A failed acknowledgement after dispatch cannot prove the PTY was untouched.
        return 'unknown'
      }
    }
    if (params.action === 'prepareCommit') {
      return { prepared: (await write(AGENT_TUI_CLEAR_INPUT_LINE, false)) === 'accepted' }
    }
    if (params.action === 'stop') {
      return { outcome: await write('\x1b', false) }
    }
    if (params.action === 'respond') {
      return { outcome: await write(params.text!, params.enter === true) }
    }
    if (params.typeCommand) {
      let index = 0
      const submitIndex = [...params.text!].length + 1
      return {
        outcome: await typeAgentTuiCommand({
          command: params.text!,
          signal: context.signal,
          write: (key) => {
            const submit = index++ === submitIndex
            return write(submit ? '' : key, submit, submit ? params.resolvedLaunchDraft : undefined)
          }
        })
      }
    }
    return {
      outcome: await write(
        `${params.clearInputFirst ? AGENT_TUI_CLEAR_INPUT_LINE : ''}${params.text!}`,
        true,
        params.resolvedLaunchDraft
      )
    }
  }
})
