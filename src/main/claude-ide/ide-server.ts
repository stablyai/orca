import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import {
  MCP_PROTOCOL_VERSION, IDE_NAME, AUTH_HEADER,
  type JsonRpcRequest,
} from './ide-protocol-types'
import type { IdeBridge, handleToolCall as HandleToolCall } from './ide-tools'

type ToolDescriptor = {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, { type: string }>; required?: string[] }
}

const IDE_TOOLS: ToolDescriptor[] = [
  {
    name: 'openDiff',
    description: 'Open a diff view between two files',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path: { type: 'string' },
        new_file_path: { type: 'string' },
        new_file_contents: { type: 'string' },
      },
      required: ['old_file_path', 'new_file_path', 'new_file_contents'],
    },
  },
  {
    name: 'openFile',
    description: 'Open a file in the editor',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
  {
    name: 'getWorkspaceFolders',
    description: 'Get the list of workspace folders',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getCurrentSelection',
    description: 'Get the current text selection',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getOpenEditors',
    description: 'Get the list of open editors',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'checkDocumentDirty',
    description: 'Check if a document has unsaved changes',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
  {
    name: 'saveDocument',
    description: 'Save a document',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  },
]

export type StartIdeServerOptions = {
  port: number
  authToken: string
  bridge: IdeBridge
  handleToolCall: typeof HandleToolCall
}

export type IdeServer = {
  port: number
  close(): Promise<void>
  notify(method: string, params: unknown): void
}

export async function startIdeServer(opts: StartIdeServerOptions): Promise<IdeServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: opts.port })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port

  const activeClients = new Set<WebSocket>()

  wss.on('connection', (ws, req) => {
    // Auth: reject any client whose header does not match this worktree's token.
    if (req.headers[AUTH_HEADER] !== opts.authToken) { ws.close(1008, 'unauthorized'); return }
    activeClients.add(ws)
    ws.on('close', () => activeClients.delete(ws))
    ws.on('message', (raw) => void dispatch(ws, raw.toString(), opts))
  })

  function notify(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    for (const client of activeClients) {
      if (client.readyState === client.OPEN) {
        client.send(msg)
      }
    }
  }

  return {
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
    notify,
  }
}

async function dispatch(ws: WebSocket, raw: string, opts: StartIdeServerOptions): Promise<void> {
  let msg: JsonRpcRequest
  try { msg = JSON.parse(raw) } catch { return }

  // Notifications must not receive a response. Property presence is the
  // JSON-RPC 2.0 rule — `id: 0` and `id: null` are valid request ids.
  if (!('id' in msg)) {return}

  const reply = (body: { result: unknown } | { error: { code: number; message: string } }) =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }))

  try {
    if (msg.method === 'initialize') {
      reply({ result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: IDE_NAME, version: '1.0.0' },
      } })
      return
    }
    if (msg.method === 'tools/list') {
      reply({ result: { tools: IDE_TOOLS } })
      return
    }
    if (msg.method === 'tools/call') {
      const params = msg.params as { name?: unknown; arguments?: unknown } | undefined
      if (!params || typeof params.name !== 'string') {
        reply({ error: { code: -32602, message: 'Invalid params: name is required' } })
        return
      }
      const args =
        params.arguments !== null && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {}
      const result = await opts.handleToolCall(opts.bridge, params.name, args)
      reply({ result })
      return
    }
    // Unknown methods get an empty success so the CLI does not stall.
    reply({ result: {} })
  } catch (err) {
    reply({ error: { code: -32000, message: (err as Error).message } })
  }
}
