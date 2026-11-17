import type { AiVaultHandoffPackArgs, AiVaultHandoffPackResult } from '../../shared/ai-vault/contracts/ai-vault-types'
import { isHandoffAgent } from '../../shared/agent-handoff-agents'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  buildAgentHandoffPack,
  renderAgentHandoffPrompt
} from '../agent-context-handoff/agent-handoff-pack'

const MAX_HANDOFF_MESSAGES = 200
const MAX_HANDOFF_CHARS = 200000

/**
 * Decode one local transcript into provider-neutral handoff text for a
 * different agent. Null whenever the transcript cannot be read or decoded;
 * callers fall back to the raw-path handoff instead of failing the dialog.
 */
export async function readAiVaultHandoffPack(
  args: AiVaultHandoffPackArgs
): Promise<AiVaultHandoffPackResult> {
  const filePath = args.filePath.trim()
  if (!filePath || !isHandoffAgent(args.agent)) {
    return { text: null }
  }
  // Why: transcript bodies live on the session host. Remote rows are skipped
  // (same posture as the first-prompt read); UI falls back to preview text.
  const executionHostId = args.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { text: null }
  }
  const maxMessages =
    typeof args.maxMessages === 'number'
      ? Math.min(Math.max(Math.floor(args.maxMessages), 1), MAX_HANDOFF_MESSAGES)
      : undefined
  const maxChars =
    typeof args.maxChars === 'number'
      ? Math.min(Math.max(Math.floor(args.maxChars), 1), MAX_HANDOFF_CHARS)
      : undefined
  // Why: partial/corrupt transcripts make parsers throw. Resolve null like every
  // other unavailable case instead of rejecting the IPC call.
  try {
    const pack = await buildAgentHandoffPack(args.agent, filePath, {
      ...(args.mode ? { mode: args.mode } : {}),
      ...(maxMessages !== undefined ? { maxMessages } : {}),
      ...(maxChars !== undefined ? { maxChars } : {})
    })
    if (!pack || pack.messages.length === 0) {
      return { text: null }
    }
    return {
      text: renderAgentHandoffPrompt(pack),
      truncated: pack.truncated,
      totalMessages: pack.totalMessages
    }
  } catch {
    return { text: null }
  }
}
