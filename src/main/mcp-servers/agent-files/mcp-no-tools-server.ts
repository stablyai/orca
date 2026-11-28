// The SDK's Server would bundle its JSON Schema validator (ajv) into `orca mcp connect`; a server
// with no tools needs only these answers.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js'

/** Answers on `transport` as an MCP server named orca that offers no tools. */
export function answerWithNoTools(transport: Transport, version: string): void {
  transport.onmessage = (message: JSONRPCMessage) => {
    if (!('method' in message) || !('id' in message)) {
      return
    }
    const { id } = message
    const answer: JSONRPCMessage =
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id, result: initializeResult(message.params?.protocolVersion, version) }
        : message.method === 'tools/list'
          ? { jsonrpc: '2.0', id, result: { tools: [] } }
          : message.method === 'ping'
            ? { jsonrpc: '2.0', id, result: {} }
            : {
                jsonrpc: '2.0',
                id,
                error: { code: ErrorCode.MethodNotFound, message: 'Method not found' }
              }
    void transport.send(answer).catch(() => {})
  }
}

function initializeResult(requested: unknown, version: string) {
  return {
    protocolVersion:
      typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'orca', version }
  }
}
