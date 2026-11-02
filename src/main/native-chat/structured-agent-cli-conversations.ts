// How a structured agent's chats meet the conversations its own CLI records: adopting one into a new
// chat, and owning the Session History rows a chat's conversation shows as.

import { isAbsolute } from 'node:path'
import { admitTranscriptPath } from './transcript-path-admission'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
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
    selectedAccountHome: AgentSessionAccountHome
  }) => AgentSessionAccountHome[]
  /** Where this account keeps its conversations (a directory, or OpenCode's database); null when
   *  it has none. Admission and lookup both take this one answer, so they cannot disagree. */
  conversationStore: (input: {
    accountHome: AgentSessionAccountHome
    /** The execution host's effective agent environment before account binding. */
    launchEnv: NodeJS.ProcessEnv
  }) => string | null
  /** Admit hook and fallback paths against the account's store. */
  admitTranscriptPath: (input: { store: string; transcriptPath: string }) => Promise<string | null>
  /** Where the transcript is (its file, or OpenCode's database); null when the store lacks it. */
  findTranscript: (input: {
    providerSessionId: string
    store: string
    launchEnv: NodeJS.ProcessEnv
    workspaceCwd: string
    strictErrors?: boolean
  }) => Promise<string | null>
  /** The adopted chat's handle names the transcript's path, not the conversation id (Pi). */
  handleNamesTranscript?: true
}

/** The import of an agent whose account is one directory, named by the chat's own variable. */
/** A store is an absolute path; anything else is none, so lookup and admission agree on it. */
export function absoluteConversationStore(path: string | null | undefined): string | null {
  const trimmed = path?.trim()
  return trimmed && isAbsolute(trimmed) ? trimmed : null
}

export function directoryTranscriptImport(directories: {
  conversationStore: (input: { accountHomePath: string; launchEnv: NodeJS.ProcessEnv }) => string | null
  accountHomeCandidates: (input: {
    settings: StructuredAgentTranscriptImportSettings
    selectedAccountHomePath: string
  }) => string[]
  /** Searches only `store`; it never derives a root of its own. */
  findTranscript: (input: {
    providerSessionId: string
    store: string
    launchEnv: NodeJS.ProcessEnv
    workspaceCwd: string
    strictErrors?: boolean
  }) => Promise<string | null>
  handleNamesTranscript?: true
}): StructuredAgentTranscriptImport {
  return {
    conversationStore: ({ accountHome, launchEnv }) =>
      isLegacyAgentSessionAccountHome(accountHome)
        ? absoluteConversationStore(
            directories.conversationStore({ accountHomePath: accountHome.path, launchEnv })
          )
        : null,
    admitTranscriptPath: async ({ store, transcriptPath }) =>
      (await admitTranscriptPath(store, transcriptPath))?.path ?? null,
    ...(directories.handleNamesTranscript ? { handleNamesTranscript: true } : {}),
    accountHomeCandidates: ({ settings, selectedAccountHome }) =>
      isLegacyAgentSessionAccountHome(selectedAccountHome)
        ? directories
            .accountHomeCandidates({ settings, selectedAccountHomePath: selectedAccountHome.path })
            .map((path) => path.trim())
            .filter((path) => path.length > 0)
            .map((path) => ({ variable: selectedAccountHome.variable, path }))
        : [],
    findTranscript: (input) => directories.findTranscript(input)
  }
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
   *  that id does, in any case. */
  resumeTargetMatches?: (target: string, rowSessionId: string) => boolean
}

/** Required on every registration, as `modelCatalog` is. */
export type StructuredAgentCliConversations = {
  /** How a chat adopts a conversation this agent's CLI recorded; null when it cannot. */
  transcriptImport: StructuredAgentTranscriptImport | null
  /** How this agent's chats own their conversations' Session History rows. */
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
