// Both ends of a shared server as bare MCP protocol peers. The SDK's Client and Server build its JSON
// Schema validator (ajv), which the packaged app doesn't ship; Orca only passes messages on, so it
// needs the protocol's ids, progress, cancel and timeouts, and the few answers below.
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  InitializeRequestSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  LoggingLevelSchema,
  SetLevelRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type InitializeResult,
  type LoggingLevel,
  type Notification,
  type Request,
  type Result
} from '@modelcontextprotocol/sdk/types.js'

/** An MCP endpoint that checks no capabilities: each side declared its own, and Orca forwards between them. */
export class McpPeer extends Protocol<Request, Notification, Result> {
  protected assertCapabilityForMethod(): void {}
  protected assertNotificationCapability(): void {}
  protected assertRequestHandlerCapability(): void {}
  protected assertTaskCapability(): void {}
  protected assertTaskHandlerCapability(): void {}
}

/** Orca as the child's client, declaring no capabilities of its own; the child's answer. */
export async function initializeChild(
  peer: McpPeer,
  transport: Transport,
  timeout: number
): Promise<InitializeResult> {
  await peer.connect(transport)
  const result = await peer.request(
    {
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'orca', version: '1.0.0' }
      }
    },
    InitializeResultSchema,
    { timeout }
  )
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
    throw new Error(`the server speaks MCP ${result.protocolVersion}, which Orca doesn't`)
  }
  await peer.notification({ method: 'notifications/initialized' })
  return result
}

const SEVERITY = LoggingLevelSchema.options

/**
 * One agent session's server end, introduced as the child: its info, capabilities and instructions,
 * at the agent's protocol version when Orca speaks it. `wants` says whether a log line at `level`
 * passes the session's own `logging/setLevel`.
 */
export function agentSessionPeer(child: InitializeResult): {
  peer: McpPeer
  wants: (level: LoggingLevel) => boolean
} {
  const peer = new McpPeer()
  let threshold: LoggingLevel | null = null
  peer.setRequestHandler(InitializeRequestSchema, ({ params }) => ({
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : LATEST_PROTOCOL_VERSION,
    capabilities: child.capabilities,
    serverInfo: child.serverInfo,
    ...(child.instructions ? { instructions: child.instructions } : {})
  }))
  if (child.capabilities.logging) {
    peer.setRequestHandler(SetLevelRequestSchema, ({ params }) => {
      threshold = params.level
      return {}
    })
  }
  return {
    peer,
    wants: (level) => threshold === null || SEVERITY.indexOf(level) >= SEVERITY.indexOf(threshold)
  }
}
