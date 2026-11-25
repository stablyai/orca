// The host list's servers for an agent's terminal, added at spawn on the host that runs it. With the
// host's switch off, or for a launch that starts no agent of a known CLI afresh, nothing changes.
import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import type { BotToolServer } from '../../../shared/bot-tools'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { MCP_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { mcpServerWorkspaceKeyOf } from '../../../shared/mcp-servers/mcp-servers'
import { addWslEnvKeys } from '../../../shared/shell/wsl/wsl-env'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { thisAppOrcaCliLauncher } from '../../cli/launchers/this-app-orca-cli-launcher'
import { botToolRelay, type BotToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import { cmdShimArgument } from '../../bots/bot-tools-claude'
import { agentOwnMcpServerNames } from '../agent-own-mcp-server-names'
import { codexArgsMcpServerNames } from '../../codex/structured/launch/codex-structured-launch-args'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { mcpServerEntriesForLaunch, type McpLaunchEntry } from '../mcp-host-list-launch'
import { mcpHostListFolder } from '../mcp-host-list-folder'
import { isMcpServersFeatureEnabled } from '../mcp-servers-feature'
import { SessionMcpTools, withSessionMcpToolsEnv } from '../session-mcp-tools'
import { noteTerminalMcpDelivery } from '../mcp-agent-problems'
import {
  terminalMcpAdapterFor,
  terminalMcpExecutable,
  type TerminalMcpAdapter,
  type TerminalMcpDelivery
} from './terminal-mcp-adapters'

/** What a pane got, so a later change to the list can tell whether it still matches. */
export type TerminalMcpPaneLaunch = {
  agent: string
  /** The pane's workspace key in the list's Workspaces (null: none). */
  workspaceKey: string | null
  workspaceId: string | null
  wsl: boolean
  /** Of the servers it was offered; null when its CLI couldn't take them, so no restart helps. */
  fingerprint: string | null
}

export type TerminalMcpLaunchInput = {
  launchAgent: TuiAgent | undefined
  command: string | undefined
  /** Mutated: the delivery's variables are added. */
  env: Record<string, string>
  /** Mutated: a variable the delivery sets is no longer deleted. */
  envToDelete: string[]
  shell: AgentStartupShell
  cwd: string | undefined
  worktreeId: string | undefined
  connectionId: string | undefined
  isFreshLaunch: boolean
  /** Set for a launch in a WSL distro. */
  wsl?: { distro: string | null }
  codexHome: string | null
}

type Deps = { relay?: Pick<BotToolRelay, 'grant'>; hostFolder?: string }

/** The `orca` launcher this host's terminals run, and the user data it names its Orca by; null when
 *  this host has none to run (a dev serve never installs one). */
async function orcaCliLauncher(): Promise<{ launcher: string; userDataPath: string } | null> {
  if (!hasAppEnvironment()) {
    return null
  }
  const userDataPath = getAppEnvironment().getPath('userData')
  const launcher = thisAppOrcaCliLauncher(userDataPath)
  const found = launcher
    ? await access(launcher).then(
        () => true,
        () => false
      )
    : false
  return launcher && found ? { launcher, userDataPath } : null
}

/**
 * A command server with saved env as `orca mcp exec <id>`: the CLI fetches the env from the running
 * Orca and execs the real command, so no saved value sits in the agent's config, argv or env.
 * `ORCA_USER_DATA_PATH` is named outright since agents start servers with a trimmed environment.
 */
function throughOrcaExec(
  entry: McpLaunchEntry,
  launch: { agent: string; workspaceId: string | null },
  cli: { launcher: string; userDataPath: string } | null
): BotToolServer | null {
  const { server } = entry
  if ('url' in server || Object.keys(server.env ?? {}).length === 0) {
    return server
  }
  if (!entry.id || !cli) {
    return null
  }
  const args = [
    'mcp',
    'exec',
    entry.id,
    '--agent',
    launch.agent,
    ...(launch.workspaceId ? ['--workspace', launch.workspaceId] : [])
  ]
  // A dev build's Windows launcher is a .cmd, which Node-based agents can only start through cmd.
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli.launcher)
  return {
    name: server.name,
    command: viaCmd ? 'cmd' : cli.launcher,
    args: viaCmd ? ['/c', cli.launcher, ...args.map(cmdShimArgument)] : args,
    env: { ORCA_USER_DATA_PATH: cli.userDataPath }
  }
}

/**
 * The servers a pane of `agent` gets, shaped for a terminal. A command server Orca runs once for
 * every session stays as it is here: SessionMcpTools points the agent at it through the relay. In
 * WSL, only servers needing neither the relay nor saved env (the guest can't reach Windows
 * loopback, and `orca mcp exec` there would run the server on Windows).
 */
async function terminalServers(
  agent: string,
  workspaceId: string | null,
  wsl: boolean,
  deps: Deps
): Promise<{
  folder: string
  servers: BotToolServer[]
  sharedProcesses: ReadonlyMap<string, string>
  bridged: BotToolServer[]
}> {
  const folder = deps.hostFolder ?? mcpHostListFolder()
  const key = workspaceId ? mcpServerWorkspaceKeyOf(workspaceId) : null
  const { entries, sharedProcesses } = await mcpServerEntriesForLaunch(agent, { key }, folder)
  const shared = (server: BotToolServer): boolean => sharedProcesses.has(server.name)
  const savedEnv = (server: BotToolServer): boolean =>
    !('url' in server) && !shared(server) && Object.keys(server.env ?? {}).length > 0
  const relayed = (server: BotToolServer): boolean =>
    'url' in server ? server.credential !== undefined : shared(server)
  const cli =
    wsl || !entries.some(({ server }) => savedEnv(server)) ? null : await orcaCliLauncher()
  const bridged: BotToolServer[] = []
  const servers = entries.flatMap((entry) => {
    const { server } = entry
    if (wsl && (relayed(server) || savedEnv(server))) {
      return []
    }
    const shaped = shared(server) ? server : throughOrcaExec(entry, { agent, workspaceId }, cli)
    if (shaped && shaped !== server) {
      bridged.push(server)
    }
    return shaped ? [shaped] : []
  })
  return { folder, servers, sharedProcesses, bridged }
}

type OfferedTools = { tools: SessionMcpTools; bridged: readonly BotToolServer[] }

/** Of what the pane runs: its servers as delivered, and the definitions behind its `orca mcp exec`
 *  bridges, whose command or saved env can change while the bridge entry stays the same. */
function fingerprintOf({ tools, bridged }: OfferedTools): string {
  return createHash('sha256')
    .update(JSON.stringify([tools.servers, tools.env, bridged]))
    .digest('hex')
}

/** The tools a pane with these settings would get now, before its agent's own same-named servers win. */
async function offeredTools(
  agent: string,
  workspaceId: string | null,
  wsl: boolean,
  deps: Deps
): Promise<OfferedTools> {
  const { bridged, ...host } = await terminalServers(agent, workspaceId, wsl, deps)
  if (host.servers.length === 0) {
    return { tools: SessionMcpTools.none, bridged }
  }
  const tools = await SessionMcpTools.for(
    deps.relay ?? botToolRelay,
    { bot: null, agent, terminal: true },
    { host }
  )
  return { tools, bridged }
}

/** The fingerprint a pane launched with these settings would have now; null with the switch off. */
export async function currentTerminalMcpFingerprint(
  pane: Pick<TerminalMcpPaneLaunch, 'agent' | 'workspaceId' | 'wsl'>,
  deps: Deps = {}
): Promise<string | null> {
  if (!isMcpServersFeatureEnabled()) {
    return null
  }
  return fingerprintOf(await offeredTools(pane.agent, pane.workspaceId, pane.wsl, deps))
}

function adapterAndExecutable(
  input: TerminalMcpLaunchInput
): { adapter: TerminalMcpAdapter; executable: string } | null {
  if (
    !input.isFreshLaunch ||
    input.connectionId ||
    !input.command ||
    !input.launchAgent ||
    !isMcpServersFeatureEnabled()
  ) {
    return null
  }
  const adapter = terminalMcpAdapterFor(input.launchAgent)
  if (!adapter) {
    return null
  }
  const executable = terminalMcpExecutable(adapter, {
    servers: [],
    token: null,
    command: input.command,
    shell: input.shell,
    env: input.env,
    cwd: input.cwd
  })
  return executable ? { adapter, executable } : null
}

/**
 * Adds the host list's servers to an agent's fresh terminal launch: the command it runs and the
 * variables it gets. Answers the command and what the pane got, or none for a launch it leaves as
 * main would (switch off, a restore, an SSH relay, an agent or command it doesn't know).
 */
export async function withTerminalMcpServers(
  input: TerminalMcpLaunchInput,
  deps: Deps = {}
): Promise<{ command: string | undefined; pane: TerminalMcpPaneLaunch | null }> {
  const unchanged = { command: input.command, pane: null }
  const found = adapterAndExecutable(input)
  if (!found) {
    return unchanged
  }
  const { adapter, executable } = found
  const wsl = input.wsl !== undefined
  const workspaceId = input.worktreeId ?? null
  const pane = (fingerprint: string | null): TerminalMcpPaneLaunch => ({
    agent: adapter.agent,
    workspaceKey: workspaceId ? mcpServerWorkspaceKeyOf(workspaceId) : null,
    workspaceId,
    wsl,
    fingerprint
  })
  if (wsl && !adapter.wsl) {
    return { command: input.command, pane: pane(null) }
  }
  let offered: OfferedTools
  try {
    offered = await offeredTools(adapter.agent, workspaceId, wsl, deps)
  } catch (error) {
    // A broken list never stops a terminal starting; its settings page shows the file's problem.
    console.warn(
      '[mcp-servers] the host list could not be read; this terminal starts without it',
      error
    )
    return unchanged
  }
  const fingerprint = fingerprintOf(offered)
  if (offered.tools.servers.length === 0) {
    return { command: input.command, pane: pane(fingerprint) }
  }
  const ownEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.env,
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {})
  }
  // Codex also takes servers from `-c mcp_servers.*` on the user's own command line.
  const parsed =
    adapter.agent === 'codex' ? tokenizeStartupCommand(input.command!, input.shell) : null
  const { tools, skipped } = offered.tools.beside([
    ...(input.cwd && !wsl ? await agentOwnMcpServerNames(adapter.agent, ownEnv, input.cwd) : []),
    ...(parsed?.ok ? codexArgsMcpServerNames(parsed.tokens) : [])
  ])
  if (skipped.length > 0) {
    console.warn(
      `[mcp-servers] ${adapter.agent}'s own settings already have ${skipped.join(', ')}; this terminal uses those instead of Orca's`
    )
  }
  if (tools.servers.length === 0) {
    return { command: input.command, pane: pane(fingerprint) }
  }
  const delivery = await adapter
    .deliver(
      {
        servers: tools.servers,
        token: tools.env[MCP_TOKEN_ENV] ?? null,
        command: input.command!,
        shell: input.shell,
        env: input.env,
        envToDelete: input.envToDelete,
        cwd: input.cwd,
        ...(input.wsl ? { wsl: input.wsl } : {})
      },
      executable
    )
    .catch((error: unknown): TerminalMcpDelivery => ({
      delivered: false,
      reason: `its launch config couldn’t be prepared (${String(error)})`,
      agentWide: false
    }))
  noteTerminalMcpDelivery(
    adapter.agent,
    delivery.delivered ? null : delivery.agentWide ? delivery.reason : undefined
  )
  if (!delivery.delivered) {
    console.warn(
      `[mcp-servers] ${adapter.agent}'s terminal starts without Orca's servers: ${delivery.reason}`
    )
    return { command: input.command, pane: pane(null) }
  }
  const added = { ...relayEnv(input.env, tools, delivery.tokenInEnv), ...delivery.env }
  Object.assign(input.env, added)
  for (const key of Object.keys(added)) {
    const at = input.envToDelete.indexOf(key)
    if (at !== -1) {
      input.envToDelete.splice(at, 1)
    }
  }
  if (wsl) {
    addWslEnvKeys(input.env, Object.keys(added))
  }
  return { command: delivery.command ?? input.command, pane: pane(fingerprint) }
}

/**
 * What the relay needs in the CLI's env: loopback past any proxy (both spellings, the user's own
 * entries kept), and the token for a CLI that reads it from `ORCA_MCP_TOKEN`.
 */
function relayEnv(
  env: Readonly<Record<string, string>>,
  tools: SessionMcpTools,
  tokenInEnv: boolean
): Record<string, string> {
  if (!tools.relayed) {
    return {}
  }
  const given = (key: 'NO_PROXY' | 'no_proxy'): Record<string, string> => {
    const value = env[key] ?? process.env[key]
    return value === undefined ? {} : { [key]: value }
  }
  const merged = withSessionMcpToolsEnv({ ...given('NO_PROXY'), ...given('no_proxy') }, tools)
  const token = tools.env[MCP_TOKEN_ENV]
  return {
    NO_PROXY: merged.NO_PROXY!,
    no_proxy: merged.no_proxy!,
    ...(tokenInEnv && token ? { [MCP_TOKEN_ENV]: token } : {})
  }
}
