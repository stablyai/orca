import type { ClaudeControlQuery } from './claude-agent-sdk-control-requests'

// The SDK implements getSettings but omits it from Query's declaration.
type ClaudeQuerySettingsReader = { getSettings?: () => Promise<unknown> }

export function claudeQuerySettingsReader(
  query: ClaudeControlQuery
): (() => Promise<unknown>) | null {
  const reader = (query as unknown as ClaudeQuerySettingsReader).getSettings
  return typeof reader === 'function' ? reader.bind(query) : null
}

// cancelAsyncMessage exists at runtime but is absent from Query's declaration.
type ClaudeQueryAsyncCanceller = { cancelAsyncMessage?: (uuid: string) => Promise<unknown> }

export function claudeQueryAsyncCanceller(
  query: ClaudeControlQuery
): ((uuid: string) => Promise<unknown>) | null {
  const cancel = (query as unknown as ClaudeQueryAsyncCanceller).cancelAsyncMessage
  return typeof cancel === 'function' ? cancel.bind(query) : null
}

// renameSession sends `rename_session` with source 'host' (the CLI's user rename) but is absent
// from Query's declaration.
export function claudeQuerySessionRenamer(
  query: ClaudeControlQuery
): ((title: string, sessionId: string) => unknown) | null {
  const rename = 'renameSession' in query ? query.renameSession : null
  return typeof rename === 'function'
    ? (title, sessionId): unknown => rename.call(query, title, sessionId)
    : null
}
