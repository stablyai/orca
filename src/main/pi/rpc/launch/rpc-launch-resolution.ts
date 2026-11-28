import { readPiSessionHeader, samePiDirectory } from './pi-session-header'
export { readPiSessionHeader, samePiDirectory } from './pi-session-header'
import { isAbsolute } from 'node:path'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { resolveCliCommand } from '../../../../shared/shell/command-resolution/node-cli-command-resolution'
import { hasReachedAppVersion } from '../../../../shared/app-lifecycle/identity/app-version'
import {
  checkAgentCliVersion,
  type AgentCliVersionCheck,
  type AgentCliVersionReader
} from '../../../agent-launch/preflight/agent-cli-version-probe'
import { AgentCliInstallationError } from '../../../native-chat/agent-launch/agent-cli-installation-error'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation,
  resolveStructuredAgentCommand,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition'
import { isWindowsProcessStartTimeAvailable } from '../../../windows/windows-process-table'
import { sessionIdFromFileName } from '../../../ai-vault/parsing/session-scanner-accumulator'
import {
  withPiVisualsEnv,
  piToolLimit,
  withoutPiCallerEnv,
  type PiRpcLaunchOptions
} from './rpc-launch'
import {
  ensurePiBackgroundWorkBridge,
  type PiBackgroundWorkLaunch
} from '../background-work/rpc-background-work-bridge'
import { piTitlebarExtensionService } from '../../managed-extensions/titlebar-extension-service'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { linkedSkillsSection } from '../../../native-chat/native-chat-skill-roots'
import { writeAcpInstructionsFile } from '../../../acp/launch/acp-instructions'
import { deliverHostMcpServersBesideConfig } from '../../../mcp-servers/session-host-mcp-delivery'
import { withSessionMcpToolsEnv } from '../../../mcp-servers/session-mcp-tools'
import {
  PI_BOT_TOOLS_EXTENSION_FILE,
  PI_BOT_TOOLS_EXTENSION_SOURCE,
  piBotToolsConfig
} from '../../../bots/bot-tools-pi'
import { writePiExtensionFile } from './pi-extension-file'
import { PI_RPC_FAMILY_PI, type PiRpcFamily, type PiRpcFamilyAgent } from '../pi-rpc-family'

export type PiRpcResolvedLaunch = PiRpcLaunchOptions & {
  family?: PiRpcFamily
  previous: AgentSessionProviderHandleLink | null
  replacement?: 'unsaved' | 'restore-failed'
  /** Conversation files, newest first; empty for a new conversation. */
  lineage?: readonly string[]
  /** Pi shrinks every image it is sent, including ones queued mid-turn. */
  shrinksImages?: true
}
export type PiRpcLaunchPartDeps = {
  family?: PiRpcFamily
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: AgentCliVersionReader
  resolveFullAccess?: () => boolean
  ensureBackgroundWorkBridge?: () => Promise<PiBackgroundWorkLaunch | null>
  managedExtensionsEnabled?: () => boolean
  logger?: StructuredAgentSessionLogger
  /** Where a chat's standing instructions are written for Pi to read. */
  dataDirectory: string
}

// RPC turns require agent_settled (Pi 0.84+); older versions remain terminal-only.
export const PI_RPC_MINIMUM_VERSIONS = PI_RPC_FAMILY_PI.minimumVersions

export function resolvePiRpcCommand(
  env: Readonly<Record<string, string>>,
  commandSettings: StructuredAgentCommandSettings = {},
  resolve?: typeof resolveCliCommand,
  agent: PiRpcFamilyAgent = 'pi'
): StructuredAgentCommand {
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveStructuredAgentCommand(
    agent,
    commandSettings,
    { pathEnv: env.PATH ?? env.Path ?? null, ...(homePath ? { homePath } : {}) },
    resolve ? { resolve } : {}
  )
}

export function checkPiRpcVersion(
  launch: {
    operation?: StructuredAgentResolutionOperation
    command: string
    prefixArgs?: readonly string[]
    cwd: string
    env: Record<string, string>
  },
  read?: AgentCliVersionReader,
  minimumVersions: readonly string[] = PI_RPC_FAMILY_PI.minimumVersions
): Promise<AgentCliVersionCheck> {
  return checkAgentCliVersion(
    {
      program: launch.command,
      prefixArgs: launch.prefixArgs,
      cwd: launch.cwd,
      env: launch.env,
      operation: launch.operation
    },
    minimumVersions,
    read
  )
}

/** Resolve chat/catalog launches identically; refresh the environment once if Pi is missing. */
export function resolvePiRpcInvocation(deps: {
  operation?: StructuredAgentResolutionOperation
  accountDir: string
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  commandSettings?: StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Base for relative PATH entries; defaults to Orca's working directory. */
  resolveWorkingDirectory?: () => Promise<string> | string
  family?: PiRpcFamily
}): Promise<StructuredAgentCommand & { env: Record<string, string> }> {
  const agent = deps.family?.agent ?? 'pi'
  return resolveAgainAfterRefreshOnMissingProgram(
    async () => {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(await deps.resolveEnvironment())) {
        if (value !== undefined) {
          env[key] = value
        }
      }
      assertStructuredAgentResolutionCurrent(deps.operation)
      env.PI_CODING_AGENT_DIR = deps.accountDir
      return { env, ...resolvePiRpcCommand(env, deps.commandSettings, deps.resolveCommand, agent) }
    },
    deps.refreshEnvironmentAfterMiss,
    { env: ({ env }) => env, cwd: deps.resolveWorkingDirectory },
    deps.operation
  )
}

export function piRpcLaunchPart(
  deps: PiRpcLaunchPartDeps
): StructuredAgentLaunchPartResolver<PiRpcResolvedLaunch> {
  const family = deps.family ?? PI_RPC_FAMILY_PI
  const { agent } = family
  return async (basis, identity) => {
    const { record } = basis
    if (process.platform === 'win32' && !isWindowsProcessStartTimeAvailable()) {
      throw new Error('Pi structured sessions require Windows process creation-time proof')
    }
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const cwd = await basis.launchDirectory()
    const { env, command, prefixArgs } = await resolvePiRpcInvocation({
      accountDir: accountHome.path,
      resolveEnvironment: basis.environment,
      commandSettings: basis.commandSettings(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: () => cwd,
      family
    })
    const previous = agentSessionProviderHandleChainHead(record.providerHandleChain)
    let sessionFile: string | undefined
    let forkFile: string | undefined
    let replacement: PiRpcResolvedLaunch['replacement']
    if (previous) {
      if (
        previous.handle.transport !== 'jsonl-rpc' ||
        previous.handle.agent !== agent ||
        !isAbsolute(previous.handle.nativeId)
      ) {
        throw new Error('Pi resume handle is not a host session file')
      }
      const source = previous.handle.nativeId
      const header = await readPiSessionHeader(source)
      if (
        previous.origin === 'adopted' &&
        (!header ||
          header.id !== sessionIdFromFileName(source) ||
          !(await samePiDirectory(header.cwd, cwd)))
      ) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'transcriptNotFound'
        })
      }
      if (header === null) {
        replacement = previous.origin === 'created' ? 'unsaved' : 'restore-failed'
      } else if (await samePiDirectory(header.cwd, cwd)) {
        sessionFile = source
      } else {
        forkFile = source
      }
    }
    // Recheck each launch because the PATH binary may have changed.
    const launchVersion = await checkPiRpcVersion(
      { command, prefixArgs, cwd, env },
      deps.probeVersion,
      family.minimumVersions
    )
    if (launchVersion.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld(agent, launchVersion)
    }
    const visuals = family.supportsSkillDirFlag ? await basis.visuals() : null
    const linked = await basis.linkedSkills()
    // Only a folder with skills; Pi loads every SKILL.md under it, links included.
    const linkedRoot =
      family.supportsSkillDirFlag && linked.projects.length > 0 ? linked.root : null
    const skillDirs = [visuals?.skill, linkedRoot].flatMap((root) =>
      root ? [root.skillsRoot] : []
    )
    if (!family.supportsSkillDirFlag && linked.projects.length > 0) {
      deps.logger?.warn(`${agent} cannot load linked project skills without a skill flag`, {
        scope: 'pi-rpc-launch'
      })
    }
    const instructions = await basis.instructions(
      linkedSkillsSection(linked.projects, linkedRoot ? [] : linked.projects)
    )
    const instructionsFile = instructions
      ? await writeAcpInstructionsFile(deps.dataDirectory, identity.sessionId, instructions)
      : undefined
    const tools = piToolLimit(basis.readOnly, launchVersion, agent)
    // Pi registers each server beside its own; a host-list server named like one of them stays out.
    const botTools = await deliverHostMcpServersBesideConfig(basis, agent, { env, cwd })
    const botServers = piBotToolsConfig(botTools)
    // Chat loads extensions from its agent dir, so subagent rows need the current status extension there.
    if (deps.managedExtensionsEnabled?.()) {
      piTitlebarExtensionService.installManagedExtensions(accountHome.path, agent)
    }
    const backgroundWork = family.supportsBackgroundWorkBridge
      ? await (
          deps.ensureBackgroundWorkBridge ??
          (() =>
            ensurePiBackgroundWorkBridge((error) =>
              deps.logger?.warn('Pi chat starts without its background-work bridge', {
                scope: 'pi-background-work',
                error
              })
            ))
        )()
      : null
    return {
      launch: {
        command,
        prefixArgs,
        fullAccess: deps.resolveFullAccess?.() ?? true,
        family,
        previous,
        ...(sessionFile || forkFile
          ? { lineage: piConversationFiles(record.providerHandleChain, agent) }
          : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(forkFile ? { forkFile } : {}),
        ...(replacement ? { replacement } : {}),
        ...(backgroundWork ? { backgroundWork } : {}),
        ...(instructionsFile ? { instructionsFile } : {}),
        ...(skillDirs.length > 0 ? { skillDirs } : {}),
        ...(tools ? { tools } : {}),
        ...(botServers
          ? {
              botTools: {
                extension: await writePiExtensionFile(
                  deps.dataDirectory,
                  PI_BOT_TOOLS_EXTENSION_FILE,
                  PI_BOT_TOOLS_EXTENSION_SOURCE
                ),
                servers: botServers
              }
            }
          : {}),
        ...(launchVersion.status === 'ready' &&
        family.shrinksEveryImageVersion !== null &&
        hasReachedAppVersion(launchVersion.version, family.shrinksEveryImageVersion)
          ? { shrinksImages: true as const }
          : {})
      },
      ...withPiVisualsEnv(withSessionMcpToolsEnv(withoutPiCallerEnv(env), botTools), visuals)
    }
  }
}

/** Follow resumes and directory forks to the original session; forks preserve entry IDs. */
function piConversationFiles(chain: AgentSessionProviderHandleChain, agent: string): string[] {
  const files: string[] = []
  for (const link of chain.toReversed()) {
    if (link.handle.transport !== 'jsonl-rpc' || link.handle.agent !== agent) {
      break
    }
    files.push(link.handle.nativeId)
    if (link.origin !== 'resumed' && link.origin !== 'forked') {
      break
    }
  }
  return files
}
