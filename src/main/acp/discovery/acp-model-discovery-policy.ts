import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
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

/** Requires a chat folder and session deletion or disposable storage to avoid persistent history. */
export type AcpSessionModelDiscovery = {
  kind: 'session'
  listingNamesConfiguredModel: boolean
  sessionFolderArgs?(folder: string): string[]
}

export function acpListingNeedsChatFolder(discovery: AcpModelDiscovery): boolean {
  return (
    discovery.kind === 'session' ||
    (discovery.kind === 'command' && discovery.otherReleasesListInSession === true)
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
