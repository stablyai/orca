import type { CanUseTool, OnUserDialog, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export const CLAUDE_CAN_USE_TOOL_SUBTYPE = 'can_use_tool'
export const CLAUDE_REQUEST_USER_DIALOG_SUBTYPE = 'request_user_dialog'

/**
 * The blocking control requests Orca answers, each mapped to the SDK consumer callback that
 * answers it. This is the stable surface a real turn can block on: `can_use_tool` through
 * `canUseTool` and `request_user_dialog` through `onUserDialog`. Every other control-request
 * subtype the SDK routes (elicitation, oauth/host token refresh, mcp_message, hook_callback)
 * is either not surfaced to this consumer or fails closed inside the SDK; adding a new
 * blocking control Orca must answer means adding its callback here, and the catalog test
 * fails if a named callback is missing.
 */
export const CLAUDE_BLOCKING_CONTROL_CALLBACKS = {
  [CLAUDE_CAN_USE_TOOL_SUBTYPE]: 'canUseTool',
  [CLAUDE_REQUEST_USER_DIALOG_SUBTYPE]: 'onUserDialog'
} as const

export type ClaudeBlockingControlSubtype = keyof typeof CLAUDE_BLOCKING_CONTROL_CALLBACKS

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
 * Build the SDK permission callbacks from the durable prompt registry.
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
      const prompt = deps.prompts.register({
        requestId: options.requestId,
        toolName,
        toolUseId: options.toolUseID,
        input,
        suggestions: options.suggestions ?? [],
        settle: resolve as (response: Record<string, unknown> | null) => void
      })
      if (!prompt) {
        resolve(denySafeResult(options.toolUseID))
        return
      }
      const cancel = (): void => {
        if (deps.prompts.forgetIfPending(prompt)) {
          deps.emit({
            type: 'prompt-cancelled',
            sessionId: deps.sessionId,
            promptKey: prompt.promptKey
          })
          // Null is the SDK's "no response written" sentinel: a cancelled request must not
          // be answered, only forgotten.
          resolve(null)
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
