import type { AgentType } from '../../../shared/native-chat-types'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import { createProviderTranscriptFileSource } from '../../native-chat/transcript-file-source'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import type { OrcaRuntimeService, RuntimeNativeChatTranscriptBinding } from '../orca-runtime'

export type NativeChatTranscriptAuthorityParams = {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  worktreeId?: string
  terminal?: string
}

export function resolveNativeChatTranscriptSource(
  runtime: OrcaRuntimeService,
  params: NativeChatTranscriptAuthorityParams
): {
  filePath?: string
  transcriptPath?: string
  fileSource?: ReturnType<typeof createProviderTranscriptFileSource>
} {
  if (!params.worktreeId || !params.terminal) {
    return params.transcriptPath ? { transcriptPath: params.transcriptPath } : {}
  }
  const binding = requireMatchingBinding(runtime, params)
  const filePath = binding.providerSession?.transcriptPath
  if (!binding.connectionId || isRuntimeOwnedSshTargetId(binding.connectionId)) {
    return filePath ? { filePath } : {}
  }
  if (!filePath) {
    throw new Error('Transcript unavailable')
  }
  const expectedConnectionId = binding.connectionId
  return {
    filePath,
    fileSource: createProviderTranscriptFileSource(() => {
      const current = requireMatchingBinding(runtime, params)
      if (current.connectionId !== expectedConnectionId) {
        throw new Error('Transcript unavailable')
      }
      const provider = getSshFilesystemProvider(expectedConnectionId)
      if (!provider) {
        throw new Error('Transcript unavailable')
      }
      return provider
    })
  }
}

function requireMatchingBinding(
  runtime: OrcaRuntimeService,
  params: NativeChatTranscriptAuthorityParams
): RuntimeNativeChatTranscriptBinding {
  if (!params.terminal) {
    throw new Error('Transcript unavailable')
  }
  const binding = runtime.resolveNativeChatTranscriptBinding(params.terminal)
  const providerSession = binding?.providerSession
  if (
    !binding ||
    binding.worktreeId !== params.worktreeId ||
    binding.agent !== params.agent ||
    providerSession?.id !== params.sessionId ||
    (params.transcriptPath !== undefined &&
      providerSession.transcriptPath !== params.transcriptPath)
  ) {
    throw new Error('Transcript unavailable')
  }
  return binding
}
