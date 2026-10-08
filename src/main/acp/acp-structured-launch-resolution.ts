// How a durable session record becomes an ACP agent launch, on the machine this runtime runs on.
//
// Every input is read back from the record the store made durable, never from the call that
// triggered the acquire: the working directory, the account home, and the provider session a
// resume names are the ones this session proved.

import { delimiter } from 'node:path'
import { homedir } from 'node:os'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleChain
} from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import { probeAgentCliVersion } from '../agent-cli-version-probe'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import {
  isProviderTimelineTurnInNamespace,
  providerTimelineKeyPart,
  spelledProviderTimelineItemKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { acpSessionNotRestoredItem } from './acp-session-reopen-failure'

export type AcpStructuredLaunch = {
  spec: AcpLaunchSpec
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Keys the child must not inherit from this process's own environment. */
  envToDelete: string[]
  fullAccess: boolean
  /** The provider session to load; null starts a new one. */
  resume: {
    sessionId: string
    /** The chain key of the session to load, which a fresh session names if it takes over. */
    key: string
    /** Only a session this chat created and never exchanged a turn on may be one the agent never
     *  saved, and so be superseded. Read only when the agent cannot reopen it. */
    mayBeUnsaved: () => boolean
    /** Keys of the conversations the chain says the agent lost whose warning row the chat does not
     *  hold, as when the attach that would have written it failed. Read once the start succeeds. */
    unannouncedLosses: () => string[]
  } | null
}

export type AcpStructuredLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  /** The chat's journal as it stands, read without opening it; null when it has none. */
  readJournal: (sessionId: string) => JournalLoad | null
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** The shared base env; re-read per acquisition. */
  resolveEnvironment: () => Promise<Record<string, string>>
  /** The user's per-agent environment overlay from settings. */
  resolveLaunchEnv?: (agent: string) => Record<string, string>
  /** The Agent Permissions setting's bypass posture for this agent, re-read per acquisition. */
  resolveFullAccess?: (agent: string) => boolean
  /** The user's per-agent Command setting, re-read per acquisition; none runs the stock binary. */
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  homePath?: string
  /** The environment the child process inherits at spawn; this process's own by default. */
  inheritedEnv?: NodeJS.ProcessEnv
  probeVersion?: typeof probeAgentCliVersion
}

/** The binary a launch with `env` spawns: the user's Command setting when set, else the stock
 *  binary from PATH, then the agent's own install directories. A create's version check resolves
 *  through here too, so it asks about the same file. */
export function resolveAcpLaunchCommand(
  spec: AcpLaunchSpec,
  env: Readonly<Record<string, string>>,
  options: {
    commandSettings?: StructuredAgentCommandSettings
    resolveCommand?: typeof resolveCliCommand
    homePath?: string
  } = {}
): string {
  const homePath = env.HOME ?? env.USERPROFILE ?? options.homePath ?? homedir()
  const pathEnv = [env.PATH ?? env.Path, ...spec.installDirectories({ env, homePath })]
    .filter((entry): entry is string => Boolean(entry))
    .join(delimiter)
  return resolveStructuredAgentCommand(
    spec.agent,
    options.commandSettings ?? {},
    { pathEnv, homePath },
    {
      command: spec.command,
      ...(options.resolveCommand ? { resolve: options.resolveCommand } : {})
    }
  )
}

/** Whether `command` is a release the spec runs a structured chat on; true when it names none. */
export async function acpLaunchVersionSupported(
  spec: AcpLaunchSpec,
  launch: { command: string; cwd: string; env: Record<string, string> },
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<boolean> {
  return (
    !spec.supportsVersion ||
    probe({ program: launch.command, cwd: launch.cwd, env: launch.env }, spec.supportsVersion)
  )
}

export function createAcpStructuredLaunchResolver(
  spec: AcpLaunchSpec,
  deps: AcpStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<AcpStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    if (record.provider !== spec.agent) {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    const { location, accountHome } = record
    // A session pinned elsewhere belongs to that host's runtime; starting it here would put a
    // second writer on the same provider session.
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
      throw new Error(
        `${spec.agent} structured sessions run on this runtime's host, not ${location.executionHostId}`
      )
    }
    const base = await deps.resolveEnvironment()
    const env: Record<string, string> = spec.account.environment(accountHome, {
      ...base,
      ...deps.resolveLaunchEnv?.(spec.agent)
    })
    const envToDelete = spec.scrubEnvironment?.(env, deps.inheritedEnv ?? process.env) ?? []
    Object.assign(env, spec.env)
    const command = resolveAcpLaunchCommand(spec, env, {
      ...deps,
      ...(deps.resolveCommandSettings ? { commandSettings: deps.resolveCommandSettings() } : {})
    })
    const cwd = await deps.resolveWorkspacePath(location.workspaceId)
    // Again at every launch: the binary on PATH may have changed since the chat was created.
    if (!(await acpLaunchVersionSupported(spec, { command, cwd, env }, deps.probeVersion))) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const fullAccess = deps.resolveFullAccess?.(spec.agent) ?? false
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    return {
      spec,
      command,
      args: spec.args({ fullAccess }),
      cwd,
      env,
      envToDelete,
      fullAccess,
      resume: head
        ? {
            sessionId: head.handle.nativeId,
            key: agentSessionProviderHandleKey(head.handle),
            mayBeUnsaved: () =>
              head.origin === 'created' &&
              nothingExchangedOn(deps.readJournal, identity.sessionId, head.handle.nativeId),
            unannouncedLosses: () =>
              unannouncedLosses(deps.readJournal, identity.sessionId, record.providerHandleChain)
          }
        : null
    }
  }
}

/** Proof the chat holds no turn of provider session `nativeId`; a journal that does not read whole,
 *  or does not read at all, proves nothing. */
function nothingExchangedOn(
  readJournal: AcpStructuredLaunchResolverDeps['readJournal'],
  sessionId: string,
  nativeId: string
): boolean {
  let load: JournalLoad | null
  try {
    load = readJournal(sessionId)
  } catch {
    return false
  }
  if (!load) {
    return true
  }
  if (load.damage || load.newer) {
    return false
  }
  for (const item of load.state.items.values()) {
    const turn = readAgentJournalTurn(item.body)
    if (turn && isProviderTimelineTurnInNamespace(turn.turnId, nativeId)) {
      return false
    }
  }
  return true
}

/** Derived on every start, never stored: a row an attach failure dropped is written by the next
 *  start that succeeds. A journal that does not read whole proves nothing, so none is written. */
function unannouncedLosses(
  readJournal: AcpStructuredLaunchResolverDeps['readJournal'],
  sessionId: string,
  chain: AgentSessionProviderHandleChain
): string[] {
  const lost = chain.flatMap((link) =>
    link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
  )
  if (lost.length === 0) {
    return []
  }
  let load: JournalLoad | null
  try {
    load = readJournal(sessionId)
  } catch {
    return []
  }
  if (!load) {
    return lost
  }
  if (load.damage || load.newer) {
    return []
  }
  const written = new Set<string>()
  for (const itemId of load.state.items.keys()) {
    const identity = parseAgentJournalItemKey(itemId)
    const spelled =
      identity?.provider === 'legacy' ? spelledProviderTimelineItemKey(identity.recordId) : null
    if (spelled !== null) {
      written.add(spelled)
    }
  }
  // Any session's row counts: one an unused replacement wrote stays when the agent supersedes it.
  return lost.filter((key) => !written.has(providerTimelineKeyPart(acpSessionNotRestoredItem(key))))
}
