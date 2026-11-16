type CdpClientCommand = {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export type CdpClientCommandParse =
  | { command: CdpClientCommand }
  | { command: null; invalidId: number | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Null params/sessionId mean absent, matching how the proxy treated them before validation.
export function parseCdpClientCommand(value: unknown): CdpClientCommandParse {
  if (!isRecord(value)) {
    return { command: null, invalidId: null }
  }
  const { id, method, params, sessionId } = value
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    return { command: null, invalidId: null }
  }
  const normalizedParams = params ?? undefined
  const normalizedSessionId = sessionId ?? undefined
  if (typeof method !== 'string' || method.length === 0) {
    return { command: null, invalidId: id }
  }
  if (normalizedParams !== undefined && !isRecord(normalizedParams)) {
    return { command: null, invalidId: id }
  }
  if (normalizedSessionId !== undefined && typeof normalizedSessionId !== 'string') {
    return { command: null, invalidId: id }
  }
  return {
    command: { id, method, params: normalizedParams, sessionId: normalizedSessionId }
  }
}
