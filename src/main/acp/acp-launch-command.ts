// Which program an ACP chat runs: its Command setting, Orca's managed release, PATH, or a host backend.

import { delimiter, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { hasExplicitTuiLaunchCommand } from '../../shared/agent-launch/startup/tui-agent-launch-command-override'
import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import {
  copyBesidePinnedMembers,
  resolveInstalledRuntimeRelease
} from '../node-runtime/managed-runtime-release'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/agent-session/environment/structured-session-child-env'
import type { AcpHostBackendSettings, AcpLaunchSpec } from './acp-launch-specs'

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
): StructuredAgentCommand {
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
  const { command } = resolve(pathEnv)
  const pinned = command !== spec.command && copyBesidePinnedMembers(command, pin)
  return { command: pinned || spec.command, prefixArgs: [] }
}

/** Chats whose account home a host backend pins launch with its spec. */
export function acpLaunchSpecForAccount(
  spec: AcpLaunchSpec,
  home: AgentSessionAccountHome
): AcpLaunchSpec {
  return spec.hostBackend?.pins(home) ? spec.hostBackend.spec : spec
}

/** The account home pinning a new chat to the compatible host program `env` finds, or null. */
export async function selectAcpHostAccountHome(
  spec: AcpLaunchSpec,
  shellEnv: Readonly<Record<string, string>>,
  stateDirectory: string,
  settings: AcpHostBackendSettings,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<AgentSessionAccountHome | null> {
  const backend = spec.hostBackend
  if (!backend) {
    return null
  }
  const env = { ...shellEnv }
  const envToDelete = [
    ...STRUCTURED_CHILD_ENV_TO_DELETE,
    ...(backend.spec.scrubEnvironment?.(env, inherited) ?? [])
  ]
  Object.assign(env, backend.spec.env)
  const homePath = env.HOME ?? env.USERPROFILE ?? homedir()
  const { command } = resolveAcpLaunchCommand(backend.spec, env, { homePath, dataDirectory: null })
  return isAbsolute(command)
    ? backend.select({ command, env, envToDelete, homePath, stateDirectory, settings })
    : null
}
