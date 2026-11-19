// A Pi bot's own tools reach its session through an extension Orca loads with it, which registers
// them for that session only (Pi 0.99+); nothing is written to the owner's mcp.json or the folder's.
import type { BotLaunchTools } from './bot-launch-tools'

export const PI_BOT_TOOLS_ENV = 'ORCA_PI_BOT_TOOLS'
export const PI_BOT_TOOLS_EXTENSION_FILE = 'orca-bot-tools.ts'

// The variable is dropped once read so the commands Pi runs don't inherit it; a server Pi refuses
// is skipped, since an extension that throws stops Pi.
export const PI_BOT_TOOLS_EXTENSION_SOURCE = [
  'export default function (pi) {',
  `  const raw = process.env.${PI_BOT_TOOLS_ENV}`,
  `  delete process.env.${PI_BOT_TOOLS_ENV}`,
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
