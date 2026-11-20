// Which program an ACP chat runs: its Command setting, Orca's managed release, PATH, or a host backend.

import { delimiter, isAbsolute } from 'node:path'
import { resolveCliCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { managedAgentCommandFor } from '../../managed-agent-cli/managed-agent-cli-registry'
import { homedir } from 'node:os'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { resolveCliCommand } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import { hasExplicitTuiLaunchCommand } from '../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
import {
  copyBesidePinnedMembers,
  resolveInstalledRuntimeRelease
} from '../../node-runtime/managed-runtime-release'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../../runtime/agent-session/environment/structured-session-child-env'
import type {
  AcpHostBackendInput,
  AcpHostBackendSettings,
  AcpLaunchSpec
} from './acp-launch-contract'

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
): StructuredAgentCommand & { version?: string } {
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
    return { ...resolve(release.folder), version: release.version }
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

// Model catalogs reuse the answer as long as the host check itself does (RECHECK_MS).
const CATALOG_SELECTION_MS = 5 * 60_000
const catalogSelections = new Map<
  string,
  { key: string; at: number; home: Promise<AgentSessionAccountHome | null> }
>()

/** The host answer for model catalogs; opening a picker reuses a recent one instead of probing. */
export function selectAcpHostAccountHomeForCatalog(
  spec: AcpLaunchSpec,
  shellEnv: Readonly<Record<string, string>>,
  stateDirectory: string,
  settings: AcpHostBackendSettings,
  now = Date.now()
): Promise<AgentSessionAccountHome | null> {
  const key = JSON.stringify([
    stateDirectory,
    settings,
    spec.hostBackend?.selectionRevision?.(),
    shellEnv.PATH ?? shellEnv.Path,
    shellEnv.HOME ?? shellEnv.USERPROFILE
  ])
  const remembered = catalogSelections.get(spec.agent)
  if (remembered?.key === key && now - remembered.at < CATALOG_SELECTION_MS) {
    return remembered.home
  }
  const home = selectAcpHostAccountHome(spec, shellEnv, stateDirectory, settings)
  catalogSelections.set(spec.agent, { key, at: now, home })
  return home
}

const WINDOWS_DRIVE_MOUNT = /^\/mnt\/[a-z]\//i

/** `command` on PATH or in its installers' folders, found without blocking; null when absent. A
 *  WSL host can't run a Windows-drive copy, so that copy doesn't count. */
export async function findHostProgram(
  command: string,
  env: Readonly<Record<string, string>>,
  installDirectories: readonly string[]
): Promise<string | null> {
  const homePath = env.HOME ?? env.USERPROFILE
  const path = env.PATH ?? env.Path ?? null
  const resolved = await resolveCliCommandAsync(command, {
    pathEnv:
      installDirectories.length > 0
        ? [path, ...installDirectories].filter(Boolean).join(delimiter)
        : path,
    ...(homePath ? { homePath } : {})
  })
  return isAbsolute(resolved) && !WINDOWS_DRIVE_MOUNT.test(resolved) ? resolved : null
}

/** What the host backend weighs for a new chat; its command is bare when nothing resolves. */
export async function acpHostBackendInput(
  spec: AcpLaunchSpec,
  shellEnv: Readonly<Record<string, string>>,
  stateDirectory: string,
  settings: AcpHostBackendSettings,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<AcpHostBackendInput | null> {
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
  const { command } = backend.spec
  const found = await findHostProgram(
    command,
    env,
    backend.spec.installDirectories({ env, homePath })
  )
  // The user's own program wins; Orca's copy serves hosts that have none.
  const managedCopy =
    backend.managedCopyServesNewChats?.(settings) !== false
      ? managedAgentCommandFor(spec.agent, command, { use: false })
      : null
  const program = found ?? managedCopy ?? command
  return { command: program, env, envToDelete, homePath, stateDirectory, settings }
}

/** The account home pinning a new chat to the compatible host program `env` finds, or null. */
export async function selectAcpHostAccountHome(
  spec: AcpLaunchSpec,
  shellEnv: Readonly<Record<string, string>>,
  stateDirectory: string,
  settings: AcpHostBackendSettings,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<AgentSessionAccountHome | null> {
  const input = await acpHostBackendInput(spec, shellEnv, stateDirectory, settings, inherited)
  // A backend may pin new chats to a program not installed yet, so Install lands where they run.
  return input && spec.hostBackend ? spec.hostBackend.select(input) : null
}

/** Whether new chats would start on a host program that is here now. */
export async function acpHostProgramTakesNewChats(
  spec: AcpLaunchSpec,
  shellEnv: Readonly<Record<string, string>>,
  stateDirectory: string,
  settings: AcpHostBackendSettings
): Promise<boolean> {
  const input = await acpHostBackendInput(spec, shellEnv, stateDirectory, settings)
  return Boolean(
    input && spec.hostBackend && isAbsolute(input.command) && (await spec.hostBackend.select(input))
  )
}
