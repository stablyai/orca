export type CodexAppServerRequestId = number | string

export type CodexAppServerInitializeResult = {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

export type CodexAppServerThread = {
  id: string
  sessionId: string
  ephemeral: boolean
  turns?: unknown[]
}

export type CodexAppServerTurn = {
  id: string
  status: string
  items?: unknown[]
  error?: unknown
}

export type CodexAppServerEvent =
  | {
      type: 'agent-message-delta'
      threadId: string
      turnId: string
      itemId: string
      delta: string
    }
  | {
      type: 'item-completed'
      threadId: string
      turnId: string
      item: unknown
      completedAtMs: number | null
    }
  | { type: 'turn-completed'; threadId: string; turn: CodexAppServerTurn }
  | { type: 'error'; threadId: string | null; message: string }

export type CodexAppServerRequest = {
  id: CodexAppServerRequestId
  method: string
  params: unknown
}

type JsonRecord = Record<string, unknown>

export function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex app-server response is missing ${key}.`)
  }
  return value
}

export function parseInitializeResult(value: unknown): CodexAppServerInitializeResult {
  const record = asJsonRecord(value)
  if (!record) {
    throw new Error('Codex app-server returned an invalid initialize response.')
  }
  return {
    userAgent: requiredString(record, 'userAgent'),
    codexHome: requiredString(record, 'codexHome'),
    platformFamily: requiredString(record, 'platformFamily'),
    platformOs: requiredString(record, 'platformOs')
  }
}

export function parseThreadResult(value: unknown): CodexAppServerThread {
  const result = asJsonRecord(value)
  const thread = asJsonRecord(result?.thread)
  if (!thread) {
    throw new Error('Codex app-server returned an invalid thread response.')
  }
  return {
    id: requiredString(thread, 'id'),
    sessionId: requiredString(thread, 'sessionId'),
    ephemeral: thread.ephemeral === true,
    ...(Array.isArray(thread.turns) ? { turns: thread.turns } : {})
  }
}

export function parseTurnResult(value: unknown): CodexAppServerTurn {
  const result = asJsonRecord(value)
  const turn = asJsonRecord(result?.turn)
  if (!turn) {
    throw new Error('Codex app-server returned an invalid turn response.')
  }
  return parseTurn(turn)
}

function parseTurn(value: JsonRecord): CodexAppServerTurn {
  const status = requiredString(value, 'status')
  return {
    id: requiredString(value, 'id'),
    status,
    ...(Array.isArray(value.items) ? { items: value.items } : {}),
    ...(value.error !== undefined ? { error: value.error } : {})
  }
}

export function parseMcpServerNames(value: unknown): string[] {
  const result = asJsonRecord(value)
  const config = asJsonRecord(result?.config)
  const servers = asJsonRecord(config?.mcp_servers)
  return servers ? Object.keys(servers) : []
}

export function parseAppServerEvent(method: string, value: unknown): CodexAppServerEvent | null {
  const params = asJsonRecord(value)
  if (!params) {
    return null
  }
  if (method === 'item/agentMessage/delta') {
    return parseAgentMessageDelta(params)
  }
  if (method === 'item/completed') {
    return {
      type: 'item-completed',
      threadId: requiredString(params, 'threadId'),
      turnId: requiredString(params, 'turnId'),
      item: params.item,
      completedAtMs: typeof params.completedAtMs === 'number' ? params.completedAtMs : null
    }
  }
  if (method === 'turn/completed') {
    const turn = asJsonRecord(params.turn)
    return turn
      ? {
          type: 'turn-completed',
          threadId: requiredString(params, 'threadId'),
          turn: parseTurn(turn)
        }
      : null
  }
  if (method === 'error') {
    const error = asJsonRecord(params.error)
    const message =
      typeof params.message === 'string'
        ? params.message
        : typeof error?.message === 'string'
          ? error.message
          : 'Codex app-server reported an error.'
    return {
      type: 'error',
      threadId: typeof params.threadId === 'string' ? params.threadId : null,
      message
    }
  }
  return null
}

function parseAgentMessageDelta(params: JsonRecord): CodexAppServerEvent {
  return {
    type: 'agent-message-delta',
    threadId: requiredString(params, 'threadId'),
    turnId: requiredString(params, 'turnId'),
    itemId: requiredString(params, 'itemId'),
    delta: requiredString(params, 'delta')
  }
}

export function isAppServerRequestId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}
