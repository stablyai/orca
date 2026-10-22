import { homedir } from 'node:os'
import { join } from 'node:path'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  directoryTranscriptImport,
  resumeInvocationFromOptions,
  type StructuredAgentResumeInvocation,
  type StructuredAgentCliConversations,
  type StructuredAgentSessionHistory
} from '../native-chat/structured-agent-cli-conversations'

const CLAUDE_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'projects'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    selectedAccountHomePath,
    join(homedir(), '.claude'),
    ...(getClaudeProfileRouter()?.accountHomes() ?? [])
  ],
  findTranscript: ({ providerSessionId, store, strictErrors }) =>
    resolveSessionFilePath('claude', providerSessionId, { claudeProjectsDir: store, strictErrors })
})

const CLAUDE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['claude'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: parseClaudeResumeArgs
}

export const CLAUDE_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: CLAUDE_TRANSCRIPT_IMPORT,
  sessionHistory: CLAUDE_SESSION_HISTORY
}

function parseClaudeResumeArgs(args: readonly string[]): StructuredAgentResumeInvocation | null {
  // Flags match in any case (`claude -C`); a lowered id still matches, as ids compare in any case.
  const folded = args.map((token) => token.toLowerCase())
  // `--continue`/`-c` never take an id, so a following token is a prompt, not a target.
  return isClaudeForkInvocation(folded)
    ? null
    : resumeInvocationFromOptions(folded, {
        targetless: ['--continue', '-c'],
        markers: ['--resume', '-r']
      })
}

/** A fork reads the conversation and writes a new one, so it is no second writer. Not when
 *  `--session-id` names the id it writes under, and nothing after `--` is an option. */
function isClaudeForkInvocation(args: readonly string[]): boolean {
  const terminatorIndex = args.indexOf('--')
  const options = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex)
  return (
    options.includes('--fork-session') &&
    !options.some((token) => token === '--session-id' || token.startsWith('--session-id='))
  )
}
