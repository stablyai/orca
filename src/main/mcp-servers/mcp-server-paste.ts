// A Custom server paste, read on the host so clients don't ship the parser: a URL, a start command,
// an mcpServers block or `claude/codex mcp add` lines, for this host's platform. A paste naming no
// server throws in words the client shows, as bots.tools.add's paste does.
import { parseMcpServersPaste } from '../../shared/bot-tool-paste'
import type { BotToolServer } from '../../shared/bot-tools'

/** The servers a paste names; a single one takes the name the client gave it. */
export function mcpServersOfPaste(source: string, name?: string): BotToolServer[] {
  const servers = parseMcpServersPaste(source, process.platform)
  return name !== undefined && servers.length === 1 ? [{ ...servers[0], name }] : servers
}
