// mcpServers.previewPaste: what a Custom server paste names, under the names Add would keep, so a
// client shows "Found 2 servers" and then sends the text itself to mcpServers.add.
import { botToolDetail, freeBotToolName } from '../../../../shared/bot-tools'
import { McpServerPreviewPaste } from '../../../../shared/rpc-contract/mcp-servers-params'
import { listMcpServers } from '../../../mcp-servers/mcp-host-list'
import { mcpServersOfPaste } from '../../../mcp-servers/mcp-server-paste'
import { defineMethod } from '../core'
import { onHost } from './mcp-servers'

export const MCP_SERVER_PASTE_METHODS = [
  defineMethod({
    name: 'mcpServers.previewPaste',
    permission: 'workspace',
    params: McpServerPreviewPaste,
    handler: (params, context) =>
      onHost(context, async () => {
        // The names Add would keep: a taken one becomes name-2, as a paste's does.
        const taken = new Set((await listMcpServers()).map((server) => server.name))
        const servers = mcpServersOfPaste(params.source).map((server) => {
          const name = freeBotToolName(server.name, taken)
          taken.add(name)
          return {
            name,
            transport: 'url' in server ? ('http' as const) : ('command' as const),
            detail: botToolDetail(server)
          }
        })
        return { servers }
      })
  })
]
