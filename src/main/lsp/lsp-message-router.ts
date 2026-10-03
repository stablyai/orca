import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import {
  isSemanticTokensLegend,
  type SemanticTokensLegend
} from '../../shared/lsp-semantic-token-legend'

export type JsonRpcId = number | string
export type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && value.jsonrpc === '2.0'
}

// Why allowlist: the renderer must never reach executeCommand, edits or config through this bridge.
const CLIENT_REQUESTS = new Set([
  'textDocument/definition',
  'textDocument/references',
  'textDocument/hover',
  'textDocument/semanticTokens/full',
  'workspace/symbol'
])
// Why: the server legend arrives once in initialize; ports ask the router instead of the server.
const SEMANTIC_TOKENS_LEGEND_REQUEST = 'orca/semanticTokensLegend'
const CLIENT_NOTIFICATIONS = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose'
])
const NULL_RESULT_SERVER_REQUESTS = new Set([
  'client/registerCapability',
  'client/unregisterCapability',
  'window/workDoneProgress/create',
  'window/showMessageRequest'
])

type Pending =
  | { kind: 'port'; portId: number; clientId: JsonRpcId }
  | { kind: 'internal'; resolve: (result: unknown) => void; reject: (error: Error) => void }

function errorReply(id: JsonRpcId, message: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code: -32601, message } }
}

function documentUri(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params.textDocument)) {
    return null
  }
  return typeof params.textDocument.uri === 'string' ? params.textDocument.uri : null
}

export class LspMessageRouter {
  private nextServerId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly documentOwners = new Map<string, Set<number>>()
  private semanticTokensLegend: SemanticTokensLegend | null = null

  constructor(
    private readonly sendToServer: (message: JsonRpcMessage) => void,
    private readonly workspaceFolders: readonly { uri: string; name: string }[]
  ) {}

  setServerCapabilities(initializeResult: unknown): void {
    const capabilities = isRecord(initializeResult) ? initializeResult.capabilities : null
    const provider = isRecord(capabilities) ? capabilities.semanticTokensProvider : null
    const legend = isRecord(provider) ? provider.legend : null
    this.semanticTokensLegend = isSemanticTokensLegend(legend) ? legend : null
  }

  fromClient(portId: number, message: JsonRpcMessage): JsonRpcMessage | null {
    const { id, method } = message
    if (method === undefined) {
      return null
    }
    if (id !== undefined && id !== null) {
      if (method === SEMANTIC_TOKENS_LEGEND_REQUEST) {
        return { jsonrpc: '2.0', id, result: this.semanticTokensLegend }
      }
      if (!CLIENT_REQUESTS.has(method)) {
        return errorReply(id, `Method not allowed: ${method}`)
      }
      const serverId = this.nextServerId++
      this.pending.set(serverId, { kind: 'port', portId, clientId: id })
      try {
        this.sendToServer({ ...message, id: serverId })
      } catch (error) {
        this.pending.delete(serverId)
        return errorReply(
          id,
          `Failed to send to server: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return null
    }
    if (CLIENT_NOTIFICATIONS.has(method)) {
      this.trackDocument(portId, method, message.params)
    }
    return null
  }

  fromServer(message: JsonRpcMessage): { portId: number; message: JsonRpcMessage } | null {
    const { id, method } = message
    if (method !== undefined) {
      if (id !== undefined && id !== null) {
        this.sendToServer(this.replyToServerRequest(id, method, message.params))
      }
      // Why: diagnostics, logs and progress are not navigation; dropping them saves the renderer the traffic.
      return null
    }
    if (typeof id !== 'number') {
      return null
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return null
    }
    this.pending.delete(id)
    if (pending.kind === 'internal') {
      if (message.error) {
        pending.reject(new Error(message.error.message))
      } else {
        pending.resolve(message.result)
      }
      return null
    }
    return { portId: pending.portId, message: { ...message, id: pending.clientId } }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextServerId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: 'internal', resolve, reject })
      try {
        this.sendToServer({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.sendToServer({ jsonrpc: '2.0', method, params })
  }

  detachPort(portId: number): void {
    for (const [uri, owners] of this.documentOwners) {
      if (owners.has(portId)) {
        owners.delete(portId)
        if (owners.size === 0) {
          this.documentOwners.delete(uri)
          this.notify('textDocument/didClose', { textDocument: { uri } })
        }
      }
    }
    for (const [id, pending] of this.pending) {
      if (pending.kind === 'port' && pending.portId === portId) {
        this.pending.delete(id)
      }
    }
  }

  rejectInternal(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.kind === 'internal') {
        pending.reject(error)
        this.pending.delete(id)
      }
    }
  }

  private trackDocument(portId: number, method: string, params: unknown): void {
    const uri = documentUri(params)
    if (!uri) {
      return
    }
    if (method === 'textDocument/didOpen') {
      const owners = this.documentOwners.get(uri) ?? new Set<number>()
      const isFirstOpener = owners.size === 0
      owners.add(portId)
      this.documentOwners.set(uri, owners)
      if (isFirstOpener) {
        this.sendToServer({ jsonrpc: '2.0', method, params })
      }
    } else if (method === 'textDocument/didChange') {
      const owners = this.documentOwners.get(uri)
      if (owners?.has(portId)) {
        this.sendToServer({ jsonrpc: '2.0', method, params })
      }
    } else if (method === 'textDocument/didClose') {
      const owners = this.documentOwners.get(uri)
      if (owners?.has(portId)) {
        owners.delete(portId)
        if (owners.size === 0) {
          this.documentOwners.delete(uri)
          this.sendToServer({ jsonrpc: '2.0', method, params })
        }
      }
    }
  }

  private replyToServerRequest(id: JsonRpcId, method: string, params: unknown): JsonRpcMessage {
    if (method === 'workspace/configuration') {
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : []
      return { jsonrpc: '2.0', id, result: items.map(() => null) }
    }
    if (method === 'workspace/workspaceFolders') {
      return { jsonrpc: '2.0', id, result: this.workspaceFolders }
    }
    if (NULL_RESULT_SERVER_REQUESTS.has(method)) {
      return { jsonrpc: '2.0', id, result: null }
    }
    return errorReply(id, `Unsupported server request: ${method}`)
  }
}
