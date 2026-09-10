import { describe, expect, it, vi } from 'vitest'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import type { AgentSessionRecordStore } from './agent-session-record-store'

/** The runtime's Claude adapter, with only the deps this wiring needs. */
function adapterWith(onConversationName: (sessionId: string, name: string) => void) {
  return createStructuredClaudeRuntimeAdapter({
    store: { getRecord: () => null } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async () => '/work/repo',
    resolveClaudeAuthPolicy: () => ({}) as never,
    onUnexpectedExit: () => {},
    onConversationName
  })
}

describe('structured Claude conversation-name wiring', () => {
  it('hands the runtime callback to the adapter that reports the name', () => {
    const onConversationName = vi.fn()

    const adapter = adapterWith(onConversationName)

    // Reaching through `deps` is the point: a callback the factory forgets to
    // forward is invisible at every other seam, and the name silently never lands.
    expect(
      (adapter as unknown as { deps: { onConversationName?: unknown } }).deps.onConversationName
    ).toBe(onConversationName)
  })

  it('gives the adapter a transcript reader for the name Claude persisted', () => {
    const adapter = adapterWith(vi.fn())

    expect(
      (adapter as unknown as { deps: { readTranscriptConversationName?: unknown } }).deps
        .readTranscriptConversationName
    ).toBeTypeOf('function')
  })
})
