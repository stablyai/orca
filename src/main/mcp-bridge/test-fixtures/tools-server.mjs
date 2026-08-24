import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'orca-shared-mcp-tools-test-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Returns the process id and input value.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } }
      }
    },
    {
      name: 'exit',
      description: 'Stops the fixture after replying.',
      inputSchema: { type: 'object' }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'exit') {
    setTimeout(() => process.exit(0), 10).unref()
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          pid: process.pid,
          value: request.params.arguments?.value ?? null
        })
      }
    ]
  }
})

await server.connect(new StdioServerTransport())
