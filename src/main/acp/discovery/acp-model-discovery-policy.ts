import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { InitializeResponse } from '../generated/acp-protocol.generated'

/** Model discovery never authenticates interactively. */
export type AcpModelDiscovery =
  | {
      kind: 'initialize'
      read(
        initialized: InitializeResponse,
        connection: {
          requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
        }
      ): Promise<AgentSessionModelOption[]>
      listingNamesConfiguredModel: boolean
    }
  | {
      kind: 'command'
      args: readonly string[]
      parse(stdout: string): AgentSessionModelOption[]
      listingNamesConfiguredModel: boolean
      /** Unsupported releases use session discovery when enabled, otherwise live-chat catalogs. */
      supportsVersion?(version: string): boolean
      otherReleasesListInSession?: true
    }
  | AcpSessionModelDiscovery
  | { kind: 'unavailable'; reason: string }

/** Needs session deletion, disposable storage or `discardSession` to leave no history behind. */
export type AcpSessionModelDiscovery = {
  kind: 'session'
  listingNamesConfiguredModel: boolean
  sessionFolderArgs?(folder: string): string[]
  /** Models follow the account, not the project, so the session runs in a private folder. */
  inPrivateFolder?: true
  /** Starting the agent is heavy, so it lists only when a picker asks, never in warm-up. */
  listsOnDemand?: true
  /** Removes a listing session, after its process exits, from an agent that can't delete sessions
   *  over ACP. */
  discardSession?(session: AcpListingSession): Promise<void>
  /** A session in the chat's folder still reports the commands that chat gets, so a resting chat
   *  reads them there (current clients ask when a `/` menu opens). */
  listsCommandsInChatFolder?: true
}

export type AcpListingSession = {
  sessionId: string
  cwd: string
  accountHomePath: string
  /** Runs the agent's own CLI with the listing's binary, account and environment. */
  runAgent(args: readonly string[]): Promise<string>
}

export function acpListingNeedsChatFolder(discovery: AcpModelDiscovery): boolean {
  return (
    (discovery.kind === 'session' && !discovery.inPrivateFolder) ||
    (discovery.kind === 'command' && discovery.otherReleasesListInSession === true)
  )
}

/** Whether a resting chat's `/` menu can read the agent's commands from a throwaway session in
 *  its folder. */
export function acpListsCommandsAtRest(discovery: AcpModelDiscovery): boolean {
  return (
    acpListingNeedsChatFolder(discovery) ||
    (discovery.kind === 'session' && discovery.listsCommandsInChatFolder === true)
  )
}

export type AcpModelListing = Exclude<AcpModelDiscovery, { kind: 'unavailable' }>

/** Whether `acpModelListingForRelease` needs the installed version. */
export function acpListingDependsOnRelease(discovery: AcpModelDiscovery): boolean {
  return discovery.kind === 'command' && discovery.supportsVersion !== undefined
}

/** How the installed release lists; null when only its chats can. */
export function acpModelListingForRelease(
  discovery: AcpModelDiscovery,
  version: string | null
): AcpModelListing | null {
  if (discovery.kind === 'unavailable') {
    return null
  }
  if (discovery.kind !== 'command' || !discovery.supportsVersion) {
    return discovery
  }
  if (version !== null && discovery.supportsVersion(version)) {
    return discovery
  }
  return discovery.otherReleasesListInSession
    ? { kind: 'session', listingNamesConfiguredModel: discovery.listingNamesConfiguredModel }
    : null
}
