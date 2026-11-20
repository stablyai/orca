// A Pi bot's own tools reach its session through an extension Orca loads with it, which registers
// them for that session only (Pi 0.99+); nothing is written to the owner's mcp.json or the folder's.
import type { AgentCliVersionCheck } from '../agent-launch/preflight/agent-cli-version-probe'
import { hasReachedAppVersion } from '../../shared/app-lifecycle/identity/app-version'
import type { BotLaunchTools } from './bot-launch-tools'

export const PI_BOT_TOOLS_ENV = 'ORCA_PI_BOT_TOOLS'
export const PI_BOT_TOOLS_EXTENSION_FILE = 'orca-bot-tools.ts'

// The variable is dropped once read so the commands Pi runs don't inherit it, and kept for the process
// so a reload, which reruns this in a fresh runtime, registers them again; a server Pi refuses is
// skipped, since an extension that throws stops Pi.
export const PI_BOT_TOOLS_EXTENSION_SOURCE = [
  `const KEPT = Symbol.for('orca.${PI_BOT_TOOLS_ENV}')`,
  'export default function (pi) {',
  `  globalThis[KEPT] ??= process.env.${PI_BOT_TOOLS_ENV}`,
  `  delete process.env.${PI_BOT_TOOLS_ENV}`,
  '  const raw = globalThis[KEPT]',
  '  if (!raw) return',
  "  if (typeof pi.registerMcpServer !== 'function') {",
  "    console.error('Orca could not add its tools: they need Pi 0.99 or later.')",
  '    return',
  '  }',
  '  for (const [name, config] of Object.entries(JSON.parse(raw))) {',
  '    try {',
  '      pi.registerMcpServer(name, config)',
  '    } catch (error) {',
  '      console.error(`Orca could not add the tool ${name}:`, error)',
  '    }',
  '  }',
  '}',
  ''
].join('\n')

// `pi.registerMcpServer`, which the extension adds the tools with.
const PI_REGISTERS_MCP_SERVERS_VERSION = '0.99.0'

/** The tools this Pi can take: an older one starts without them, and the session and Tools rows say why. */
export function piLaunchBotTools(
  tools: BotLaunchTools,
  launchVersion: AgentCliVersionCheck
): { tools: BotLaunchTools; note: string | null } {
  if (
    launchVersion.status !== 'ready' ||
    hasReachedAppVersion(launchVersion.version, PI_REGISTERS_MCP_SERVERS_VERSION)
  ) {
    return { tools, note: null }
  }
  return tools.without(
    () => true,
    `Pi 0.99 or later is needed, and this computer has Pi ${launchVersion.version}. Update Pi to turn tools on.`
  )
}

/** The servers as Pi's `mcp.json` entries, by name; null when there are none. */
export function piBotToolsConfig(tools: BotLaunchTools): string | null {
  if (tools.servers.length === 0) {
    return null
  }
  return JSON.stringify(
    Object.fromEntries(
      tools.servers.map((server) => [
        server.name,
        'url' in server
          ? { url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
          : {
              command: server.command,
              args: server.args,
              ...(server.env ? { env: server.env } : {})
            }
      ])
    )
  )
}
