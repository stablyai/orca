export type AgentStatusStoreNegotiation = 'capable' | 'legacy' | 'unavailable'

export function isUnsupportedAgentStatusStoreMethod(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return code === -32601
}
