// JSON-RPC 2.0 / MCP message + Claude Code lockfile shapes.
// Why: the claude CLI requires VS Code-compatible field names exactly.

export type IdeLockfile = {
  pid: number
  workspaceFolders: string[]
  ideName: string
  transport: 'ws'
  runningInWindows: boolean
  authToken: string
}

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

// Why: JSON-RPC 2.0 requires exactly one of result/error — never both or neither.
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string } }

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const IDE_NAME = 'Orca'
export const AUTH_HEADER = 'x-claude-code-ide-authorization'
