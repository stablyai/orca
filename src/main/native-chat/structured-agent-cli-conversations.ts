// How a structured agent's chats meet the conversations its own CLI records: adopting one into a new
// chat, and owning the Session History rows a chat's conversation shows as.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'

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
  /** Whether a resume target names the conversation listed under `rowSessionId`; absent, only
   *  that exact id does. */
  resumeTargetMatches?: (target: string, rowSessionId: string) => boolean
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

/** The command names that run the agent's CLI binaries, lower-case, with and without `.exe`: a
 *  token names one when its path's last name does, in any case. */
export function sessionHistoryBinaryNames(history: StructuredAgentSessionHistory): string[] {
  return history.rowAgents.flatMap((agent) => {
    const binary = TUI_AGENT_CONFIG[agent].expectedProcess.toLowerCase()
    return [binary, `${binary}.exe`]
  })
}

/** The resume a marker flag asks for: the token after it, unless that is another option. Flags
 *  match in any case. */
export function resumeInvocationAfterMarker(
  args: readonly string[],
  markers: readonly string[]
): StructuredAgentResumeInvocation | null {
  return invocationAfter(
    args,
    args.findIndex((token) => markers.includes(token.toLowerCase()))
  )
}

function invocationAfter(
  args: readonly string[],
  markerIndex: number
): StructuredAgentResumeInvocation | null {
  if (markerIndex === -1) {
    return null
  }
  const candidate = args[markerIndex + 1]
  return { target: candidate && !candidate.startsWith('-') ? candidate : null }
}

/** Whether the command's options include one of `flags`, matched exactly as a case-sensitive
 *  CLI reads them; after `--` a flag is prompt text. */
export function ownOptionsInclude(args: readonly string[], flags: readonly string[]): boolean {
  const terminator = args.indexOf('--')
  return (terminator === -1 ? args : args.slice(0, terminator)).some((token) =>
    flags.includes(token)
  )
}

/** The resume a command's options ask for, matched exactly as a case-sensitive CLI reads them
 *  (`rg x src/pi -C 3` is no `pi -c`): a target-less flag may pick any conversation, a marker
 *  resumes its value (`--marker=value` too). */
export function resumeInvocationFromOptions(
  args: readonly string[],
  options: { targetless: readonly string[]; markers: readonly string[] }
): StructuredAgentResumeInvocation | null {
  if (args.some((token) => options.targetless.includes(token))) {
    return { target: null }
  }
  const inline = args.find((token) =>
    options.markers.some((marker) => token.startsWith(`${marker}=`))
  )
  if (inline !== undefined) {
    const target = inline.slice(inline.indexOf('=') + 1)
    return { target: target.length > 0 ? target : null }
  }
  return invocationAfter(
    args,
    args.findIndex((token) => options.markers.includes(token))
  )
}

/** For a CLI that resumes a session file by its id, any prefix of it, or the file's path: the
 *  same file-name id Session History lists the file under. */
export function sessionFileResumeTargetMatches(target: string, rowSessionId: string): boolean {
  const id = rowSessionId.toLowerCase()
  return id.startsWith(target.toLowerCase()) || sessionIdFromFileName(target).toLowerCase() === id
}
