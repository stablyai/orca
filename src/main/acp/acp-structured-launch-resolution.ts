import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
// Launch from durable record values for the working directory, pinned account and resume session.

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
import {
  checkAgentCliVersion,
  type AgentCliVersionCheck,
  type AgentCliVersionReader
} from '../agent-cli-version-probe'
import { AgentCliInstallationError } from '../native-chat/agent-cli-installation-error'
import {
  copyBesidePinnedMembers,
  resolveInstalledRuntimeRelease
} from '../node-runtime/managed-runtime-release'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import {
  isProviderTimelineTurnInNamespace,
  providerTimelineKeyPart,
  spelledProviderTimelineItemKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV,
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
  /** Sealed for spawns; recovery reads use the unsealed agent environment. */
  env: Record<string, string>
  envToDelete: string[]
  fullAccess: boolean
  resume: {
    sessionId: string
    key: string
    /** A chat-created session with no exchanged turn may never have been saved. */
    mayBeUnsaved: () => boolean
    /** Lost conversations whose warning rows are missing; read after startup succeeds. */
    unannouncedLosses: () => string[]
  } | null
}

export type AcpStructuredLaunchPartDeps = {
  /** Reads without opening the journal. */
  readJournal: (sessionId: string) => JournalLoad | null
  resolveCommand?: typeof resolveCliCommand
  homePath?: string
  inheritedEnv?: NodeJS.ProcessEnv
  probeVersion?: AgentCliVersionReader
  dataDirectory: string
} & Pick<AcpLaunchVisualsDeps, 'logger'>

export type AcpLaunchInvocationDeps = {
  operation?: StructuredAgentResolutionOperation
  /** Reread per acquisition. */
  resolveEnvironment: () => Promise<Record<string, string>>
  resolveLaunchEnv?: (agent: string) => Record<string, string>
  /** Reread per acquisition; absent uses the stock command. */
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  /** Optional environment refresh after a missing-program lookup. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Resolves relative PATH entries against the launch directory. */
  resolveWorkingDirectory?: () => Promise<string> | string
} & Pick<
  AcpStructuredLaunchPartDeps,
  'resolveCommand' | 'homePath' | 'inheritedEnv' | 'dataDirectory'
>

/** Prefer explicit commands, then managed releases, then complete pinned copies on PATH. */
export function resolveAcpLaunchCommand(
  spec: AcpLaunchSpec,
  env: Readonly<Record<string, string>>,
  options: {
    commandSettings?: StructuredAgentCommandSettings
    resolveCommand?: typeof resolveCliCommand
    homePath?: string
    dataDirectory: string | null
  }
): string {
  const homePath = env.HOME ?? env.USERPROFILE ?? options.homePath ?? homedir()
  const pathEnv = [env.PATH ?? env.Path, ...spec.installDirectories({ env, homePath })]
    .filter((entry): entry is string => Boolean(entry))
    .join(delimiter)
  const settings = spec.ignoreAgentCommandSetting ? {} : (options.commandSettings ?? {})
  const resolve = (searchPath: string) =>
    resolveStructuredAgentCommand(
      spec.agent,
      settings,
      { pathEnv: searchPath, homePath },
      {
        command: spec.command,
        ...(options.resolveCommand ? { resolve: options.resolveCommand } : {})
      }
    )
  const { managedRuntime } = spec
  if (!managedRuntime || hasExplicitTuiLaunchCommand(settings, spec.agent)) {
    return resolve(pathEnv)
  }
  const pin = managedRuntime.pin()
  const root = options.dataDirectory && managedRuntime.root(options.dataDirectory)
  const release = root ? resolveInstalledRuntimeRelease(root, pin).release : null
  if (release) {
    return resolve(release.folder)
  }
  const found = resolve(pathEnv)
  return (found !== spec.command && copyBesidePinnedMembers(found, pin)) || spec.command
}

export async function checkAcpLaunchVersion(
  spec: AcpLaunchSpec,
  launch: { command: string; cwd: string; env: Record<string, string> },
  wantVersion: boolean,
  read?: AgentCliVersionReader
): Promise<AgentCliVersionCheck> {
  if (!spec.minimumVersions && !wantVersion) {
    return { status: 'unknown', version: null }
  }
  return checkAgentCliVersion(
    { program: launch.command, cwd: launch.cwd, env: launch.env },
    spec.minimumVersions ?? [],
    read
  )
}

/** Resolve chats and probes consistently; optionally refresh once after a missing-program lookup. */
export function resolveAcpLaunchInvocation(
  spec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  deps: AcpLaunchInvocationDeps
): Promise<{ command: string; env: Record<string, string>; envToDelete: string[] }> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readAcpLaunchInvocation(spec, accountHome, deps),
    deps.refreshEnvironmentAfterMiss,
    { env: ({ env }) => env, cwd: deps.resolveWorkingDirectory },
    deps.operation
  )
}

async function readAcpLaunchInvocation(
  spec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  deps: AcpLaunchInvocationDeps
): Promise<{ command: string; env: Record<string, string>; envToDelete: string[] }> {
  assertStructuredAgentResolutionCurrent(deps.operation)
  const base = await deps.resolveEnvironment()
  assertStructuredAgentResolutionCurrent(deps.operation)
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

export function acpStructuredLaunchPart(
  spec: AcpLaunchSpec,
  deps: AcpStructuredLaunchPartDeps
): StructuredAgentLaunchPartResolver<AcpStructuredLaunch> {
  return async (basis, identity) => {
    const { record } = basis
    const { env, envToDelete, command } = await resolveAcpLaunchInvocation(
      spec,
      record.accountHome,
      {
        resolveEnvironment: basis.baseEnvironment,
        resolveLaunchEnv: () => basis.launchEnv(),
        resolveCommandSettings: basis.commandSettings,
        refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
        resolveWorkingDirectory: basis.launchDirectory,
        ...(deps.resolveCommand ? { resolveCommand: deps.resolveCommand } : {}),
        ...(deps.homePath ? { homePath: deps.homePath } : {}),
        ...(deps.inheritedEnv ? { inheritedEnv: deps.inheritedEnv } : {}),
        dataDirectory: deps.dataDirectory
      }
    )
    const cwd = await basis.launchDirectory()
    const visuals = spec.visualsSkill ? await basis.visuals() : null
    // PATH may have changed since chat creation.
    const launchVersion = await checkAcpLaunchVersion(
      spec,
      { command, cwd, env },
      visuals !== null,
      deps.probeVersion
    )
    if (launchVersion.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld(spec.agent, launchVersion)
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
    const fullAccess = basis.permissionMode === 'full-access'
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
        // An inherited scratch directory belongs to a different chat.
        ...(skill ? [] : [NATIVE_CHAT_SCRATCH_DIR_ENV]),
        LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
      ]
    }
  }
}

/** Missing journals count as empty; read errors or damaged/newer journals cannot prove no exchange. */
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

/** Retry missing loss-warning rows on successful starts; unreadable journals suppress new warnings. */
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
  // Warnings survive even if the replacement session that wrote them is superseded.
  return lost.filter((key) => !written.has(providerTimelineKeyPart(acpSessionNotRestoredItem(key))))
}
