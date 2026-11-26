/** A host's own MCP server list, which a phone shows and edits on the host it names; spread into the
 *  execution-host routes. Gated on mcp-servers.v1; a host with its switch off refuses each one. */
export const MOBILE_MCP_SERVER_RPC_METHODS = [
  'mcpServers.add',
  'mcpServers.agentFiles.allow',
  'mcpServers.cancelProblems',
  'mcpServers.copy',
  'mcpServers.details',
  'mcpServers.discover',
  'mcpServers.list',
  'mcpServers.move',
  'mcpServers.previewPaste',
  'mcpServers.problems',
  'mcpServers.remove',
  'mcpServers.sessions.restart',
  'mcpServers.sessions.stale',
  'mcpServers.setAgentEnabled',
  'mcpServers.setSharedProcess',
  'mcpServers.setWorkspaces',
  'mcpServers.signIn.cancel',
  'mcpServers.signIn.finish',
  'mcpServers.signIn.start',
  'mcpServers.signIn.wait',
  'mcpServers.signOut',
  'mcpServers.update'
] as const
