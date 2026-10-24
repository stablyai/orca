import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTerminalClientTab,
  RuntimeNativeChatFileContext
} from '../../shared/runtime-types'
import { recentTerminalOutputIncludesPath } from '../runtime/terminal-output-path-candidates'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Nodes } from 'mdast'
import { routeNativeChatHref } from '../../shared/native-chat-href-routing'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

const markdownParser = unified().use(remarkParse)

function markdownIncludesPath(node: Nodes, pathText: string, absolutePath: string): boolean {
  if (node.type === 'image' || node.type === 'link' || node.type === 'definition') {
    const route = routeNativeChatHref(node.url)
    if (route.kind === 'file' && (route.pathText === pathText || route.pathText === absolutePath)) {
      return true
    }
  }
  return (
    'children' in node &&
    node.children.some((child) => markdownIncludesPath(child, pathText, absolutePath))
  )
}

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
  if (
    /\]\s*[(:]|<[^>\s]+:/.test(text) &&
    markdownIncludesPath(markdownParser.parse(text), pathText, absolutePath)
  ) {
    return true
  }
  // Mobile excludes a sentence-final period from the tappable path span.
  return recentTerminalOutputIncludesPath(text, `${pathText}.`, `${absolutePath}.`)
}

function assistantMessageIncludesPath(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>,
  pathText: string,
  absolutePath: string
): boolean {
  return (
    message.role === 'assistant' &&
    message.blocks.some((block) => {
      if (block.type === 'text') {
        return transcriptTextIncludesPath(block.text, pathText, absolutePath)
      }
      if (block.type !== 'image-ref') {
        return false
      }
      if (block.path === pathText || block.path === absolutePath) {
        return true
      }
      const route = routeNativeChatHref(block.url)
      return (
        route.kind === 'file' && (route.pathText === pathText || route.pathText === absolutePath)
      )
    })
  )
}

export async function nativeChatTranscriptIncludesPath(args: {
  tabs: readonly RuntimeMobileSessionClientTab[]
  context: RuntimeNativeChatFileContext
  pathText: string
  absolutePath: string
  readTranscript?: TranscriptRead
  readStructuredMessages?: (
    sessionId: string
  ) => Promise<readonly Pick<NativeChatMessage, 'role' | 'blocks'>[]>
}): Promise<boolean> {
  const structuredTab = args.tabs.find(
    (tab) =>
      tab.type === 'agent-session' &&
      (tab.id === args.context.tabId ||
        structuredAgentSessionTabId(tab.sessionId) === args.context.tabId) &&
      tab.sessionId === args.context.sessionId
  )
  if (structuredTab) {
    try {
      const messages = await args.readStructuredMessages?.(args.context.sessionId)
      return (
        messages?.some((message) =>
          assistantMessageIncludesPath(message, args.pathText, args.absolutePath)
        ) ?? false
      )
    } catch {
      return false
    }
  }
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
    return result.messages.some((message) =>
      assistantMessageIncludesPath(message, args.pathText, args.absolutePath)
    )
  } catch {
    return false
  }
}
