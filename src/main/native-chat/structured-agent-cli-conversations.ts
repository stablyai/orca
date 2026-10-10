// How a structured agent's chats meet the conversations its own CLI records: adopting one into a new
// chat, and owning the Session History rows a chat's conversation shows as.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

/** What the runtime hands an importer: the settings that name extra account homes. */
export type StructuredAgentTranscriptImportSettings = {
  codexManagedAccounts?: readonly { managedHomePath: string }[]
}

/** Finds a conversation the agent's CLI recorded, so a new chat can adopt it. */
export type StructuredAgentTranscriptImport = {
  /** Recognised account homes, most-preferred first; the first that holds the transcript wins. */
  accountHomeCandidates: (input: {
    settings: StructuredAgentTranscriptImportSettings
    selectedAccountHomePath: string
  }) => string[]
  findTranscript: (input: {
    providerSessionId: string
    accountHomePath: string
  }) => Promise<string | null>
}

/** A terminal resume's target: null when it may pick any conversation (`--continue`, a bare flag). */
export type StructuredAgentResumeInvocation = { target: string | null }

/** How a chat owns its conversation's Session History rows, and refuses a terminal second writer. */
export type StructuredAgentSessionHistory = {
  /** The Session History row agents a chat's conversation lists under (one CLI may list as more);
   *  their CLIs' binaries are what a terminal resume of it runs. */
  rowAgents: readonly AiVaultAgent[]
  /** The history row id a link of the chat's handle chain shows as. */
  rowSessionId: (link: AgentSessionProviderHandleLink) => string
  /** The resume the arguments after the binary ask for; null when they resume nothing. */
  parseResumeArgs: (args: readonly string[]) => StructuredAgentResumeInvocation | null
}

/** Required on every registration, as `modelCatalog` is: an agent without one says `null`. An
 *  importer needs `sessionHistory`: adopting makes the chat the conversation's owner, and the
 *  duplicate-adoption check finds owners by the row id it names. */
export type StructuredAgentCliConversations =
  | {
      /** How a chat adopts a conversation this agent's CLI recorded; null when it cannot. */
      transcriptImport: null
      /** How this agent's chats own their Session History rows; null when they own none. */
      sessionHistory: StructuredAgentSessionHistory | null
    }
  | {
      transcriptImport: StructuredAgentTranscriptImport
      sessionHistory: StructuredAgentSessionHistory
    }

/** Whether a command token names one of the agent's CLI binaries: by its path's last name, any
 *  case, with or without `.exe`. */
export function isSessionHistoryBinary(
  history: StructuredAgentSessionHistory,
  token: string
): boolean {
  const name = token.split(/[\\/]/).at(-1)?.toLowerCase()
  return history.rowAgents.some((agent) => {
    const binary = TUI_AGENT_CONFIG[agent].expectedProcess.toLowerCase()
    return name === binary || name === `${binary}.exe`
  })
}

/** The resume a marker flag asks for: the token after it, unless that is another option. */
export function resumeInvocationAfterMarker(
  args: readonly string[],
  markers: readonly string[]
): StructuredAgentResumeInvocation | null {
  const markerIndex = args.findIndex((token) => markers.includes(token.toLowerCase()))
  if (markerIndex === -1) {
    return null
  }
  const candidate = args[markerIndex + 1]
  return { target: candidate && !candidate.startsWith('-') ? candidate : null }
}
