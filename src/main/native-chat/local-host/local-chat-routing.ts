import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RpcRequest } from '../../runtime/rpc/core'
import {
  CreateIntentParams,
  CreateSupportParams
} from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import type { LocalChatHostClient } from './local-chat-host-client'

let client: LocalChatHostClient | undefined

export function installLocalChatClient(next: LocalChatHostClient): void {
  client = next
}

export function localChatClient(): LocalChatHostClient | undefined {
  return client
}

// PTY ownership evidence lives in Desktop, including when chat execution is detached.
export async function checkLocalChatTerminalWriters(
  runtime: OrcaRuntimeService,
  request: RpcRequest
): Promise<void> {
  if (request.method === 'agentSession.createSupport') {
    const { agent, resumeFrom } = CreateSupportParams.parse(request.params)
    if (resumeFrom) {
      await runtime.assertStructuredAdoptionTerminalWritersExited(
        agent,
        resumeFrom.providerSessionId,
        resumeFrom.closingPaneKeys
      )
    }
  } else if (request.method === 'agentSession.create') {
    const intent = CreateIntentParams.safeParse(request.params)
    if (intent.success && intent.data.resumeFrom) {
      await runtime.assertStructuredAdoptionTerminalWritersExited(
        intent.data.agent,
        intent.data.resumeFrom.providerSessionId
      )
    }
  }
}
