import { join } from 'node:path'
import { agentModelCatalogInputStamp } from '../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { InitializeResponse } from '../generated/acp-protocol.generated'

/** Model discovery never authenticates interactively. */
export type AcpModelDiscovery =
  | {
      kind: 'initialize'
      /** `home` is the resolved account home path the launch will pin (null when the agent locates accounts another way). */
      read(
        initialized: InitializeResponse,
        connection: {
          requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
        },
        home: string | null
      ): Promise<AgentSessionModelOption[]>
      listingNamesConfiguredModel: boolean
      /** Catalog inputs under the pinned home, named relative to it; stamped so edits expire cached lists. */
      homeConfigFiles?: readonly string[]
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
   *  over ACP; `cwd` is the private folder it ran in, so only that session matches. */
  discardSession?(session: AcpListingSession): Promise<void>
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

/** Serialized stamp inputs covering every discovery-relevant launch directory and home config file. */
export async function acpModelCatalogStampInput(
  discovery: AcpModelDiscovery,
  launch: {
    command: string
    prefixArgs: readonly string[]
    cwd: string
    workspace: string
    env: NodeJS.ProcessEnv
    home: string | null
  }
): Promise<string> {
  const { home } = launch
  const configFiles =
    discovery.kind === 'initialize' && home && discovery.homeConfigFiles
      ? discovery.homeConfigFiles.map((name) => join(home, name))
      : undefined
  const directories = [
    ...new Set([
      launch.cwd,
      ...(discovery.kind === 'command' && launch.workspace ? [launch.workspace] : [])
    ])
  ]
  return JSON.stringify(
    await Promise.all(
      directories.map((directory) =>
        agentModelCatalogInputStamp({
          command: launch.command,
          prefixArgs: launch.prefixArgs,
          cwd: directory,
          env: launch.env,
          configFiles
        })
      )
    )
  )
}
