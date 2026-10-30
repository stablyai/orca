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

export type StructuredAgentTranscriptImportSettings = {
  codexManagedAccounts?: readonly { managedHomePath: string }[]
}

export type StructuredAgentTranscriptImport = {
  /** First transcript hit wins; order preferred account homes first. */
  accountHomeCandidates: (input: {
    settings: StructuredAgentTranscriptImportSettings
    selectedAccountHome: AgentSessionAccountHome
  }) => AgentSessionAccountHome[]
  /** Admission and lookup share one store path; null means this account has none. */
  conversationStore: (input: {
    accountHome: AgentSessionAccountHome
    launchEnv: NodeJS.ProcessEnv
  }) => string | null
  admitTranscriptPath: (input: { store: string; transcriptPath: string }) => Promise<string | null>
  findTranscript: (input: {
    providerSessionId: string
    store: string
    launchEnv: NodeJS.ProcessEnv
    workspaceCwd: string
    strictErrors?: boolean
  }) => Promise<string | null>
  /** Pi handles name the transcript path rather than conversation ID. */
  handleNamesTranscript?: true
}

/** Relative stores are invalid for both lookup and admission. */
export function absoluteConversationStore(path: string | null | undefined): string | null {
  const trimmed = path?.trim()
  return trimmed && isAbsolute(trimmed) ? trimmed : null
}

export function directoryTranscriptImport(directories: {
  conversationStore: (input: {
    accountHomePath: string
    launchEnv: NodeJS.ProcessEnv
  }) => string | null
  accountHomeCandidates: (input: {
    settings: StructuredAgentTranscriptImportSettings
    selectedAccountHomePath: string
  }) => string[]
  /** Never derive fallback roots outside this store. */
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

/** null permits any conversation, e.g. bare --continue. */
export type StructuredAgentResumeInvocation = { target: string | null }

export type StructuredAgentSessionHistory = {
  /** One CLI may own rows under several names; these also identify terminal-resume binaries. */
  rowAgents: readonly AiVaultAgent[]
  rowSessionId: (link: AgentSessionProviderHandleLink) => string
  parseResumeArgs: (args: readonly string[]) => StructuredAgentResumeInvocation | null
  /** Defaults to case-insensitive rowSessionId equality. */
  resumeTargetMatches?: (target: string, rowSessionId: string) => boolean
}

export type StructuredAgentCliConversations = {
  transcriptImport: StructuredAgentTranscriptImport | null
  sessionHistory: StructuredAgentSessionHistory
}

/** Match binary basenames case-insensitively, with or without .exe. */
export function sessionHistoryBinaryNames(history: StructuredAgentSessionHistory): string[] {
  return history.rowAgents.flatMap((agent) => {
    const binary = TUI_AGENT_CONFIG[agent].expectedProcess.toLowerCase()
    return [binary, `${binary}.exe`]
  })
}

/** Marker flags match case-insensitively; another option is never a target. */
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

/** CLI flags are case-sensitive; tokens after -- are prompt text. */
export function ownOptionsInclude(args: readonly string[], flags: readonly string[]): boolean {
  const terminator = args.indexOf('--')
  return (terminator === -1 ? args : args.slice(0, terminator)).some((token) =>
    flags.includes(token)
  )
}

/** Parse target-less flags or marker values, including --marker=value, with exact CLI option matching. */
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

/** Match session IDs, ID prefixes or transcript paths against History’s filename ID. */
export function sessionFileResumeTargetMatches(target: string, rowSessionId: string): boolean {
  const id = rowSessionId.toLowerCase()
  return id.startsWith(target.toLowerCase()) || sessionIdFromFileName(target).toLowerCase() === id
}
