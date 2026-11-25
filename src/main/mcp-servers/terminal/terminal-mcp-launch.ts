// The host list's servers for an agent's terminal, added at spawn on the host that runs it. With the
// host's switch off, or for a launch that starts no agent of a known CLI afresh, nothing changes.
import { createHash } from 'node:crypto'
import type { BotToolServer } from '../../../shared/bot-tools'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { MCP_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { mcpServerWorkspaceKeyOf } from '../../../shared/mcp-servers/mcp-servers'
import { addWslEnvKeys } from '../../../shared/shell/wsl/wsl-env'
import { botToolRelay, type BotToolRelay } from '../../bots/tool-relay/bot-tool-relay'
import { terminalServers, type WslLaunch } from './terminal-mcp-servers'
import { agentOwnMcpServerNames } from '../agent-own-mcp-server-names'
import { codexArgsMcpServerNames } from '../../codex/structured/launch/codex-structured-launch-args'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
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
  /** The distro a WSL pane runs in (null: the default one). */
  wslDistro?: string | null
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
  wsl: WslLaunch,
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
  pane: Pick<TerminalMcpPaneLaunch, 'agent' | 'workspaceId' | 'wsl' | 'wslDistro'>,
  deps: Deps = {}
): Promise<string | null> {
  if (!isMcpServersFeatureEnabled()) {
    return null
  }
  const wsl = pane.wsl ? { distro: pane.wslDistro ?? null } : null
  return fingerprintOf(await offeredTools(pane.agent, pane.workspaceId, wsl, deps))
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
  const wsl = input.wsl ?? null
  const workspaceId = input.worktreeId ?? null
  const pane = (fingerprint: string | null): TerminalMcpPaneLaunch => ({
    agent: adapter.agent,
    workspaceKey: workspaceId ? mcpServerWorkspaceKeyOf(workspaceId) : null,
    workspaceId,
    wsl: wsl !== null,
    ...(wsl ? { wslDistro: wsl.distro } : {}),
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
