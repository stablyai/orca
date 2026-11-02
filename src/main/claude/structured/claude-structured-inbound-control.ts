import type { CanUseTool, OnUserDialog, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePromptRegistry } from '../claude-prompt-registry'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import type { ClaudeStreamJsonConnectionHandlers } from '../claude-stream-json-connection'
import type { ClaudeStructuredLaunch } from './launch/claude-structured-launch-resolution'
import { claudeLaunchSkipsPermissions } from './launch/claude-structured-spawn-options'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'
import {
  claudePermissionPresentation,
  claudePermissionSubject
} from '../claude-permission-presentation'

export type ClaudePermissionCallbackDeps = {
  sessionId: string
  prompts: ClaudePromptRegistry
  emit: (event: ClaudeStructuredSessionEvent) => void
  /** Read once per request: whether this process's Full access applied where the request arrived. */
  fullAccessAt: (requestId: string) => boolean
}

/** Questions and plan approval need the user's answer, not a permission; Full access never answers them. */
const USER_ANSWERED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** The SDK forwards the CLI's flag for tools whose card is the person's answer, though its type omits it. */
function needsUserAnswer(toolName: string, options: Parameters<CanUseTool>[2]): boolean {
  return (
    USER_ANSWERED_TOOLS.has(toolName) ||
    ('requiresUserInteraction' in options && options.requiresUserInteraction === true)
  )
}

function denySafeResult(toolUseId: string | undefined): PermissionResult {
  return {
    behavior: 'deny',
    message: 'Orca could not decode this permission request.',
    ...(toolUseId ? { toolUseID: toolUseId } : {})
  }
}

/** Malformed requests are denied; provider cancellation forgets the callback without replying. */
export function buildClaudePermissionCallbacks(deps: ClaudePermissionCallbackDeps): {
  canUseTool: CanUseTool
  onUserDialog: OnUserDialog
} {
  const canUseTool: CanUseTool = (toolName, input, options) => {
    const fullAccess = deps.fullAccessAt(options.requestId)
    // Full access approves Claude's own asks too (ask rules, ask-answering hooks, built-in safety checks).
    if (fullAccess && toolName && !needsUserAnswer(toolName, options)) {
      return Promise.resolve({
        behavior: 'allow',
        updatedInput: input,
        ...(options.toolUseID ? { toolUseID: options.toolUseID } : {})
      })
    }
    return new Promise<PermissionResult | null>((resolve) => {
      let cancel = (): void => {}
      const settle = (response: PermissionResult | null): void => {
        options.signal.removeEventListener('abort', cancel)
        resolve(response)
      }
      const subject = claudePermissionSubject(toolName, input)
      const prompt = deps.prompts.register({
        ...claudePermissionPresentation(options),
        ...(subject ? { subject } : {}),
        requestId: options.requestId,
        toolName,
        toolUseId: options.toolUseID,
        input,
        suggestions: options.suggestions ?? [],
        settle,
        ...(options.agentID ? { agentId: options.agentID } : {})
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
          // Null tells the SDK to write no response to the cancelled request.
          settle(null)
        }
      }
      if (options.signal.aborted) {
        // Abort events are not replayed for listeners added after cancellation.
        cancel()
        return
      }
      options.signal.addEventListener('abort', cancel, { once: true })
      deps.emit({ type: 'prompt', sessionId: deps.sessionId, prompt })
    })
  }

  const onUserDialog: OnUserDialog = () => Promise.resolve({ behavior: 'cancelled' })

  return { canUseTool, onUserDialog }
}

/** One process's permission handlers. Only Orca's Full access launch grants auto-allow; Own settings
 *  never does, whatever Claude reports, and no other process's launch or reports carry over. */
export function claudeLaunchPermissions(
  deps: Omit<ClaudePermissionCallbackDeps, 'fullAccessAt'>,
  launch: Pick<ClaudeStructuredLaunch, 'options' | 'providerSessionId'>
): {
  handlers: Pick<ClaudeStreamJsonConnectionHandlers, 'canUseTool' | 'onUserDialog' | 'onStdout'>
  close: () => void
} {
  const policy = claudeLaunchSkipsPermissions(launch.options)
    ? createClaudeFullAccessPolicy(launch.providerSessionId)
    : null
  const callbacks = buildClaudePermissionCallbacks({
    ...deps,
    fullAccessAt: (requestId) => policy?.allows(requestId) ?? false
  })
  return {
    handlers: { ...callbacks, ...(policy ? { onStdout: policy.observe } : {}) },
    close: () => policy?.close()
  }
}
