import type { CanUseTool, OnUserDialog, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudePermissionPresentation,
  claudePermissionSubject
} from './claude-permission-presentation'

export type ClaudePermissionCallbackDeps = {
  sessionId: string
  prompts: ClaudePromptRegistry
  emit: (event: ClaudeStructuredSessionEvent) => void
}

function denySafeResult(toolUseId: string | undefined): PermissionResult {
  return {
    behavior: 'deny',
    message: 'Orca could not decode this permission request.',
    ...(toolUseId ? { toolUseID: toolUseId } : {})
  }
}

/**
 * Build the SDK permission callbacks from the session-local prompt registry.
 *
 * A decodable `can_use_tool` becomes a durable prompt whose `settle` resolves this callback;
 * a malformed one is denied without registering. The SDK's abort signal fires on
 * `control_cancel_request` (a cancelled turn), which forgets the prompt and settles it with
 * `null` — never authorizing a tool. A late answer after abort finds no prompt and is refused
 * by `answerClaudePrompt`. `onUserDialog` is deny-safe; the CLI only emits dialog kinds Orca
 * declares in `supportedDialogKinds`, which is empty.
 */
export function buildClaudePermissionCallbacks(deps: ClaudePermissionCallbackDeps): {
  canUseTool: CanUseTool
  onUserDialog: OnUserDialog
} {
  const canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult | null>((resolve) => {
      let cancel = (): void => {}
      const settle = (response: PermissionResult | null): void => {
        options.signal.removeEventListener('abort', cancel)
        resolve(response)
      }
      // Classify first so later permission-mode policy cannot swallow a plan proposal.
      const subject = claudePermissionSubject(toolName, input)
      const prompt = deps.prompts.register({
        ...claudePermissionPresentation(options),
        ...(subject ? { subject } : {}),
        requestId: options.requestId,
        toolName,
        toolUseId: options.toolUseID,
        input,
        suggestions: options.suggestions ?? [],
        settle
      })
      if (!prompt) {
        settle(denySafeResult(options.toolUseID))
        return
      }
      cancel = (): void => {
        if (deps.prompts.forgetIfPending(prompt)) {
          deps.emit({
            type: 'prompt-cancelled',
            sessionId: deps.sessionId,
            promptKey: prompt.promptKey
          })
          // Null is the SDK's "no response written" sentinel: a cancelled request must not
          // be answered, only forgotten.
          settle(null)
        }
      }
      if (options.signal.aborted) {
        // No abort event can still fire, so registering a listener would park the callback
        // forever behind a prompt nothing will answer.
        cancel()
        return
      }
      options.signal.addEventListener('abort', cancel, { once: true })
      deps.emit({ type: 'prompt', sessionId: deps.sessionId, prompt })
    })

  const onUserDialog: OnUserDialog = () => Promise.resolve({ behavior: 'cancelled' })

  return { canUseTool, onUserDialog }
}
