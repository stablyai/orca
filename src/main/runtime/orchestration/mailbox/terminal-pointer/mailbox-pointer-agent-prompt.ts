import type {
  AgentPromptExpectedBinding,
  RuntimeAgentPromptWriteOptions
} from '../../../terminal/input/agent-prompt-write-options'
import type { RuntimeTerminalSend } from '../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'

export type MailboxPointerPromptResult = 'submitted' | 'refused' | 'unverifiable'

export type MailboxPointerPromptRequest = {
  target: OrchestrationMailboxPointerSubmitTarget
  prompt: string
  requestId: string
  assertCurrent: () => void
  beforeSubmit: () => void
}

type PointerPromptHost = {
  getBinding: (handle: string) => AgentPromptExpectedBinding
  sendPrompt: (
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ) => Promise<RuntimeTerminalSend>
  readScreen: (ptyId: string) => Promise<{ draft?: string } | null | undefined>
  readDrivingInputAt: (ptyId: string) => number | null
}

/** Keep the prompt API's Windows paste recovery, but never lend it an unowned composer. */
export async function sendMailboxPointerAgentPrompt(
  host: PointerPromptHost,
  request: MailboxPointerPromptRequest
): Promise<MailboxPointerPromptResult> {
  const { ptyId } = request.target.terminal
  const drivingInputAt = host.readDrivingInputAt(ptyId)
  let pasteAttempted = false
  let submitAttempted = false
  try {
    const expectedBinding = host.getBinding(request.target.terminal.handle)
    request.assertCurrent()
    if (expectedBinding.ptyId !== ptyId) {
      return 'refused'
    }
    const result = await host.sendPrompt(request.target.terminal.handle, request.prompt, {
      inputKind: 'orchestration',
      expectedBinding,
      acceptQueued: true,
      requestId: request.requestId,
      observationTimeoutMs: 0,
      beforeWrite: async () => {
        const screen = await host.readScreen(ptyId)
        request.assertCurrent()
        if (!screen || host.readDrivingInputAt(ptyId) !== drivingInputAt) {
          throw new Error('mailbox_pointer_composer_changed')
        }
        const draft = screen.draft?.replace(/\r\n?/g, '\n').trim() ?? ''
        if (!pasteAttempted) {
          if (draft !== '') {
            throw new Error('mailbox_pointer_composer_occupied')
          }
          pasteAttempted = true
          return
        }
        // An empty composer may already have submitted; a different draft belongs to the user.
        if (draft.replace(/\s+/g, ' ') !== request.prompt.replace(/\s+/g, ' ').trim()) {
          throw new Error('mailbox_pointer_composer_changed')
        }
        if (!submitAttempted) {
          request.beforeSubmit()
          submitAttempted = true
        }
      }
    })
    return result.prompt?.stages.includes('turn_started') ? 'submitted' : 'unverifiable'
  } catch {
    // After admission even a thrown write may have handed bytes to a remote transport.
    return pasteAttempted ? 'unverifiable' : 'refused'
  }
}
