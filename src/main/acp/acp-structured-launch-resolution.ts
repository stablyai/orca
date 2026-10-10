// How a durable session record becomes an ACP agent launch, on the machine this runtime runs on.
//
// Every input is read back from the record the store made durable, never from the call that
// triggered the acquire: the working directory, the account home, and the provider session a
// resume names are the ones this session proved.

import { delimiter } from 'node:path'
import { homedir } from 'node:os'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleChain
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
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
import type {
  StructuredAgentLaunchBasis,
  StructuredAgentLaunchPart,
  StructuredLaunchRequest
} from '../runtime/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import {
  NATIVE_CHAT_VISUALS_DIR_ENV,
  withNativeChatVisualsEnv
} from '../native-chat/native-chat-visuals-delivery'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { acpSessionNotRestoredItem } from './acp-session-reopen-failure'
import { loadAcpVisualsSkill, type AcpLaunchVisualsDeps } from './acp-structured-launch-visuals'

export type AcpStructuredLaunch = {
  spec: AcpLaunchSpec
  command: string
  args: string[]
  cwd: string
  /** The child's sealed environment; a read that starts no child gets the agent's own. */
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

export type AcpStructuredLaunchPartDeps = {
  /** The chat's journal as it stands, read without opening it; null when it has none. */
  readJournal: (sessionId: string) => JournalLoad | null
  /** The Agent Permissions setting's bypass posture for this agent, re-read per acquisition. */
  resolveFullAccess?: (agent: string) => boolean
  resolveCommand?: typeof resolveCliCommand
  homePath?: string
  /** The environment the child process inherits at spawn; this process's own by default. */
  inheritedEnv?: NodeJS.ProcessEnv
  probeVersion?: typeof probeAgentCliVersion
} & Pick<AcpLaunchVisualsDeps, 'logger'>

/** What a launch's binary and environment are read from; a catalog probe reads the same. */
export type AcpLaunchInvocationDeps = {
  /** The shared base env; re-read per acquisition. */
  resolveEnvironment: () => Promise<Record<string, string>>
  /** The user's per-agent environment overlay from settings. */
  resolveLaunchEnv?: (agent: string) => Record<string, string>
  /** The user's per-agent Command setting, re-read per acquisition; none runs the stock binary. */
  resolveCommandSettings?: () => StructuredAgentCommandSettings
} & Pick<AcpStructuredLaunchPartDeps, 'resolveCommand' | 'homePath' | 'inheritedEnv'>

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

/** Whether `command` is a release the spec runs a structured chat on (true when it names none),
 *  and the version it printed. Asked only when the spec names releases or `wantVersion`. */
async function probeAcpLaunchVersion(
  spec: AcpLaunchSpec,
  launch: { command: string; cwd: string; env: Record<string, string> },
  wantVersion: boolean,
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<{ supported: boolean; version: string | null }> {
  const { supportsVersion } = spec
  if (!supportsVersion && !wantVersion) {
    return { supported: true, version: null }
  }
  const seen: { version: string | null } = { version: null }
  const answered = await probe(
    { program: launch.command, cwd: launch.cwd, env: launch.env },
    (version) => {
      seen.version = version
      return supportsVersion?.(version) ?? true
    }
  )
  // Without named releases a failed probe costs only what needed the version.
  return { supported: answered || !supportsVersion, version: answered ? seen.version : null }
}

/** Whether `command` is a release the spec runs a structured chat on; true when it names none. */
export async function acpLaunchVersionSupported(
  spec: AcpLaunchSpec,
  launch: { command: string; cwd: string; env: Record<string, string> },
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<boolean> {
  return (await probeAcpLaunchVersion(spec, launch, false, probe)).supported
}

/** The binary and environment any child of this agent runs under for `accountHome`: a session's
 *  launch and a catalog probe both resolve here, so neither can reach another account or install. */
export async function resolveAcpLaunchInvocation(
  spec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  deps: AcpLaunchInvocationDeps
): Promise<{ command: string; env: Record<string, string>; envToDelete: string[] }> {
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
  return { command, env, envToDelete }
}

/** An ACP agent's part of a launch: its binary under the pinned account, the release check, the
 *  visuals skill, its arguments and the provider session to reattach. */
export function acpStructuredLaunchPart(
  spec: AcpLaunchSpec,
  deps: AcpStructuredLaunchPartDeps
): (
  basis: StructuredAgentLaunchBasis,
  request: StructuredLaunchRequest
) => Promise<StructuredAgentLaunchPart<AcpStructuredLaunch>> {
  return async (basis, { identity }) => {
    const { record } = basis
    const { env, envToDelete, command } = await resolveAcpLaunchInvocation(
      spec,
      record.accountHome,
      {
        resolveEnvironment: basis.baseEnvironment,
        resolveLaunchEnv: () => basis.launchEnv(),
        resolveCommandSettings: basis.commandSettings,
        ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
        ...(deps.homePath ? { homePath: deps.homePath } : {}),
        ...(deps.inheritedEnv ? { inheritedEnv: deps.inheritedEnv } : {})
      }
    )
    const cwd = await basis.launchDirectory()
    const visuals = spec.visualsSkill ? await basis.visuals() : null
    // Again at every launch: the binary on PATH may have changed since the chat was created.
    const launchVersion = await probeAcpLaunchVersion(
      spec,
      { command, cwd, env },
      visuals !== null,
      deps.probeVersion
    )
    if (!launchVersion.supported) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    const skill = visuals
      ? await loadAcpVisualsSkill(spec, deps, {
          sessionId: identity.sessionId,
          visuals,
          version: launchVersion.version,
          env,
          envToDelete,
          inherited: deps.inheritedEnv ?? process.env
        })
      : null
    const fullAccess = deps.resolveFullAccess?.(spec.agent) ?? false
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    return {
      launch: {
        spec,
        command,
        args: spec.args({ fullAccess, pluginDir: skill?.pluginDir ?? null }),
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
      },
      env: withNativeChatVisualsEnv({ ...env, ...skill?.env }, skill ? visuals : null),
      inheritedEnvToDelete: [
        ...STRUCTURED_CHILD_ENV_TO_DELETE,
        ...envToDelete,
        // Without visuals, a folder Orca itself inherited (started from a chat) names another chat's.
        ...(skill ? [] : [NATIVE_CHAT_VISUALS_DIR_ENV])
      ]
    }
  }
}

/** Proof the chat holds no turn of provider session `nativeId`; a journal that does not read whole,
 *  or does not read at all, proves nothing. */
function nothingExchangedOn(
  readJournal: AcpStructuredLaunchPartDeps['readJournal'],
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
  readJournal: AcpStructuredLaunchPartDeps['readJournal'],
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
