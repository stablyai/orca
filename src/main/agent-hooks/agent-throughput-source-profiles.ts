import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { readLastClaudeMessageThroughput } from '../../shared/agent-hook-listener/claude-transcript-throughput'
import { readLastCodexMessageThroughput } from '../../shared/agent-hook-listener/codex-transcript-throughput'
import { readLastGeminiMessageThroughput } from '../../shared/agent-hook-listener/gemini-chat-throughput'
import {
  getGrokChatHistoryPath,
  readGrokHomeEnvelope
} from '../../shared/agent-hook-listener/grok-result-discovery'
import { readLastGrokMessageThroughput } from '../../shared/agent-hook-listener/grok-session-throughput'
import { readFirstString } from '../../shared/agent-hook-listener/interactive-tool'
import { isGrokEvent } from '../../shared/agent-hook-listener/provider-event-names'
import type { AgentMessageThroughput } from '../../shared/agent-throughput-types'
import { readLastOpenCodeMessageThroughput } from '../opencode/opencode-message-throughput'

export type ThroughputHookAction = 'reset' | 'new-turn' | 'measure' | 'measure-streaming' | 'ignore'

/** How one hook source maps its events to throughput actions and where it reads the last call from. */
export type AgentThroughputSourceProfile = {
  classify: (hookEventName: string, payload: Record<string, unknown>) => ThroughputHookAction
  read: (
    payload: Record<string, unknown>,
    /** The hook envelope around the payload (pane key, worktree, per-runtime home dirs). */
    envelope: Record<string, unknown>
  ) => AgentMessageThroughput | undefined | Promise<AgentMessageThroughput | undefined>
  /** Floor between `measure-streaming` reads; those events fire while a message is still streaming. */
  streamingReadIntervalMs?: number
}

// Why: each fires once a message is complete; the post-tool events double as a retry for a
// transcript row that was still unflushed when the pre-tool event arrived.
const CLAUDE_STYLE_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'PostCompact'
])
const GEMINI_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'BeforeTool',
  'AfterTool',
  'AfterAgent'
])
const OPENCODE_COMPLETE_EVENTS: ReadonlySet<string> = new Set([
  'SessionIdle',
  'PermissionRequest',
  'AskUserQuestion'
])
const OPENCODE_STREAMING_READ_INTERVAL_MS = 1_500

// Why: a reading must not outlive the session that produced it, so SessionEnd clears it like
// SessionStart does. Orca installs that hook for Grok only today; the others keep their last
// reading until a new session starts in the pane.
function classifyClaudeStyleHook(hookEventName: string): ThroughputHookAction {
  if (hookEventName === 'SessionStart' || hookEventName === 'SessionEnd') {
    return 'reset'
  }
  if (hookEventName === 'UserPromptSubmit') {
    return 'new-turn'
  }
  return CLAUDE_STYLE_COMPLETE_EVENTS.has(hookEventName) ? 'measure' : 'ignore'
}

function readWithTranscript(
  read: (transcriptPath: string) => AgentMessageThroughput | undefined
): AgentThroughputSourceProfile['read'] {
  return (payload) => {
    const transcriptPath = readFirstString(payload, ['transcript_path', 'transcriptPath'])
    return transcriptPath ? read(transcriptPath) : undefined
  }
}

const OPENCODE_PROFILE: AgentThroughputSourceProfile = {
  classify: (hookEventName, payload) => {
    if (hookEventName === 'SessionStart') {
      return 'reset'
    }
    if (hookEventName === 'MessagePart') {
      return payload.role === 'user'
        ? 'new-turn'
        : payload.role === 'assistant'
          ? 'measure-streaming'
          : 'ignore'
    }
    return OPENCODE_COMPLETE_EVENTS.has(hookEventName) ? 'measure' : 'ignore'
  },
  read: (payload) => {
    const sessionId = readFirstString(payload, ['sessionID', 'sessionId', 'session_id'])
    return sessionId ? readLastOpenCodeMessageThroughput(sessionId) : undefined
  },
  streamingReadIntervalMs: OPENCODE_STREAMING_READ_INTERVAL_MS
}

const GROK_PROFILE: AgentThroughputSourceProfile = {
  classify: (hookEventName) => {
    if (isGrokEvent(hookEventName, 'session_start', 'session_end')) {
      return 'reset'
    }
    if (isGrokEvent(hookEventName, 'user_prompt_submit')) {
      return 'new-turn'
    }
    return isGrokEvent(
      hookEventName,
      'pre_tool_use',
      'post_tool_use',
      'post_tool_use_failure',
      'stop',
      'stop_failure'
    )
      ? 'measure'
      : 'ignore'
  },
  read: (payload, envelope) => {
    const chatHistoryPath = getGrokChatHistoryPath(payload, readGrokHomeEnvelope(envelope))
    return chatHistoryPath ? readLastGrokMessageThroughput(chatHistoryPath) : undefined
  }
}

/** Sources with a per-message token record Orca can reach, plus Grok's text-length estimate. */
export const AGENT_THROUGHPUT_SOURCE_PROFILES: Partial<
  Record<AgentHookSource, AgentThroughputSourceProfile>
> = {
  claude: {
    classify: classifyClaudeStyleHook,
    read: readWithTranscript(readLastClaudeMessageThroughput)
  },
  codex: {
    classify: classifyClaudeStyleHook,
    read: readWithTranscript(readLastCodexMessageThroughput)
  },
  gemini: {
    classify: (hookEventName) => {
      if (hookEventName === 'SessionStart' || hookEventName === 'SessionEnd') {
        return 'reset'
      }
      if (hookEventName === 'BeforeAgent') {
        return 'new-turn'
      }
      return GEMINI_COMPLETE_EVENTS.has(hookEventName) ? 'measure' : 'ignore'
    },
    read: readWithTranscript(readLastGeminiMessageThroughput)
  },
  opencode: OPENCODE_PROFILE,
  'mimo-code': OPENCODE_PROFILE,
  grok: GROK_PROFILE
}
