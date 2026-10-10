import { homedir } from 'node:os'
import { join } from 'node:path'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  resumeInvocationAfterMarker,
  type StructuredAgentResumeInvocation,
  type StructuredAgentCliConversations,
  type StructuredAgentSessionHistory,
  type StructuredAgentTranscriptImport
} from '../native-chat/structured-agent-cli-conversations'

const CLAUDE_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    selectedAccountHomePath,
    join(homedir(), '.claude'),
    ...(getClaudeProfileRouter()?.accountHomes() ?? [])
  ],
  findTranscript: ({ providerSessionId, accountHomePath }) =>
    resolveSessionFilePath('claude', providerSessionId, {
      claudeProjectsDir: join(accountHomePath, 'projects')
    })
}

const CLAUDE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['claude'],
  rowSessionId: (link) => link.handle.nativeId,
  executable: 'claude',
  parseResumeArgs: parseClaudeResumeArgs
}

export const CLAUDE_CLI_CONVERSATIONS: StructuredAgentCliConversations = {
  transcriptImport: CLAUDE_TRANSCRIPT_IMPORT,
  sessionHistory: CLAUDE_SESSION_HISTORY
}

function parseClaudeResumeArgs(args: readonly string[]): StructuredAgentResumeInvocation | null {
  if (isClaudeForkInvocation(args)) {
    return null
  }
  // `--continue`/`-c` resume the most recent session and never take an id, so a
  // following token is a prompt, not a target — they are always target-less.
  const targetlessFlags = ['--continue', '-c']
  if (args.some((token) => targetlessFlags.includes(token.toLowerCase()))) {
    return { target: null }
  }
  const inline = args.find(
    (token) => token.toLowerCase().startsWith('--resume=') || token.toLowerCase().startsWith('-r=')
  )
  if (inline !== undefined) {
    const target = inline.slice(inline.indexOf('=') + 1)
    return { target: target.length > 0 ? target : null }
  }
  return resumeInvocationAfterMarker(args, ['--resume', '-r'])
}

/** A fork reads the conversation and writes a new one, so it is no second writer. Not when
 *  `--session-id` names the id it writes under, and nothing after `--` is an option. */
function isClaudeForkInvocation(args: readonly string[]): boolean {
  const terminatorIndex = args.indexOf('--')
  const options = (terminatorIndex === -1 ? args : args.slice(0, terminatorIndex)).map((token) =>
    token.toLowerCase()
  )
  return (
    options.includes('--fork-session') &&
    !options.some((token) => token === '--session-id' || token.startsWith('--session-id='))
  )
}
