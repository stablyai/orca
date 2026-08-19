import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTerminalClientTab,
  RuntimeNativeChatFileContext
} from '../../shared/runtime-types'
import { recentTerminalOutputIncludesPath } from '../runtime/terminal-output-path-candidates'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

// Match the largest transcript window mobile can render so any visible citation remains provable.
const NATIVE_CHAT_FILE_PROVENANCE_WINDOW = 2000

type TranscriptRead = (args: {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  limit: number
}) => Promise<{ messages: NativeChatMessage[] } | { error: string }>

function transcriptTextIncludesPath(text: string, pathText: string, absolutePath: string): boolean {
  if (recentTerminalOutputIncludesPath(text, pathText, absolutePath)) {
    return true
  }
  // Mobile excludes a sentence-final period from the tappable path span.
  return recentTerminalOutputIncludesPath(text, `${pathText}.`, `${absolutePath}.`)
}

export async function nativeChatTranscriptIncludesPath(args: {
  tabs: readonly RuntimeMobileSessionClientTab[]
  context: RuntimeNativeChatFileContext
  pathText: string
  absolutePath: string
  readTranscript?: TranscriptRead
}): Promise<boolean> {
  const tab = args.tabs.find(
    (candidate): candidate is RuntimeMobileSessionTerminalClientTab =>
      candidate.type === 'terminal' && candidate.id === args.context.tabId
  )
  const providerSession = tab?.agentStatus?.providerSession
  const agent = tab?.agentStatus?.agentType ?? tab?.launchAgent
  if (
    !tab ||
    !providerSession ||
    providerSession.id !== args.context.sessionId ||
    !agent ||
    !resolveNativeChatTranscriptAgent(agent)
  ) {
    return false
  }

  try {
    const result = await (args.readTranscript ?? readNativeChatTranscriptTail)({
      agent,
      sessionId: providerSession.id,
      ...(providerSession.transcriptPath ? { transcriptPath: providerSession.transcriptPath } : {}),
      limit: NATIVE_CHAT_FILE_PROVENANCE_WINDOW
    })
    if (!('messages' in result)) {
      return false
    }
    return result.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.blocks.some(
          (block) =>
            block.type === 'text' &&
            transcriptTextIncludesPath(block.text, args.pathText, args.absolutePath)
        )
    )
  } catch {
    return false
  }
}
