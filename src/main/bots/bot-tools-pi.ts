// A Pi bot's own tools reach its session through an extension Orca loads with it, which registers
// them for that session only (Pi 0.99+); nothing is written to the owner's mcp.json or the folder's.
import type { BotToolServer } from '../../shared/bot-tools'
import type { SessionMcpTools } from '../mcp-servers/session-mcp-tools'

export const PI_BOT_TOOLS_ENV = 'ORCA_PI_BOT_TOOLS'
export const PI_BOT_TOOLS_EXTENSION_FILE = 'orca-bot-tools.ts'

/**
 * An extension that registers the servers `envName` holds (Pi's `mcp.json` entries, by name). The
 * variable is dropped once read so the commands Pi runs don't inherit it, and kept for the process
 * so a reload, which reruns this in a fresh runtime, registers them again; a server Pi refuses is
 * skipped, since an extension that throws stops Pi.
 */
export function piMcpServersExtensionSource(envName: string): string {
  return [
    `const KEPT = Symbol.for('orca.${envName}')`,
    'export default function (pi) {',
    `  globalThis[KEPT] ??= process.env.${envName}`,
    `  delete process.env.${envName}`,
    '  const raw = globalThis[KEPT]',
    "  if (!raw || typeof pi.registerMcpServer !== 'function') return",
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
}

export const PI_BOT_TOOLS_EXTENSION_SOURCE = piMcpServersExtensionSource(PI_BOT_TOOLS_ENV)

/** The servers as Pi's `mcp.json` entries, by name. */
export function piMcpServersConfig(servers: readonly BotToolServer[]): string {
  return JSON.stringify(
    Object.fromEntries(
      servers.map((server) => [
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

/** The servers as Pi's `mcp.json` entries, by name; null when there are none. */
export function piBotToolsConfig(tools: SessionMcpTools): string | null {
  return tools.servers.length === 0 ? null : piMcpServersConfig(tools.servers)
}
