import { packagedClaudeChatScenario } from '../orcad/orcad-structured-chat-scenario'

/** The normal streamed reply stays open for an approval and the user's Stop. */
export function wslClaudeChatScenario(providerSessionId: string, partialReplyAckPath: string) {
  const scenario = packagedClaudeChatScenario(providerSessionId, partialReplyAckPath)
  return {
    ...scenario,
    steps: [
      ...scenario.steps
        .slice(0, -2)
        .map((step) =>
          step.awaitFile ? { awaitFile: { ...step.awaitFile, timeoutMs: 120_000 } } : step
        ),
      {
        emit: {
          type: 'control_request',
          request_id: 'wsl-permission',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'wsl-tool'
          }
        }
      },
      { awaitControlResponse: 'wsl-permission' },
      { awaitControlRequest: 'interrupt' },
      {
        emit: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: providerSessionId,
          uuid: 'wsl-interrupted',
          errors: ['Interrupted by the user']
        }
      },
      { delayMs: 250 }
    ]
  }
}
