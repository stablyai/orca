import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'

const listClaudeSubagentSessions = vi.hoisted(() => vi.fn())
const listOmpSubagentSessions = vi.hoisted(() => vi.fn())

// Only the per-agent listers are replaced; the entry and its reader run for real.
vi.mock('./session-scanner-claude-subagents', () => ({ listClaudeSubagentSessions }))
vi.mock('./session-scanner-omp-subagent-listing', () => ({ listOmpSubagentSessions }))
vi.mock('./session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist: vi.fn(() => Promise.resolve()),
  initSessionParseCachePersistence: vi.fn()
}))

type SentMessage = { type: string; id?: number; operation?: string; value?: unknown }
const sent: SentMessage[] = []

function emit(message: unknown): void {
  process.emit('message', message, undefined)
}

async function requestSubagents(
  id: number,
  agent: 'claude' | 'omp',
  parentFilePath: string
): Promise<SentMessage | undefined> {
  emit({ type: 'request', id, operation: 'subagents', request: { agent, parentFilePath } })
  await vi.waitFor(() => expect(sent.some((message) => message.id === id)).toBe(true))
  return sent.find((message) => message.id === id)
}

describe('AI Vault service entry subagent listing', () => {
  beforeAll(async () => {
    process.send = (message: SentMessage) => {
      sent.push(message)
      return true
    }
    await import('./session-scanner-service-entry')
    emit({ type: 'init', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION })
  })

  beforeEach(() => {
    sent.length = 0
    listClaudeSubagentSessions.mockReset()
    listOmpSubagentSessions.mockReset()
  })

  it('lists Claude subagents with the Claude lister only', async () => {
    const claude = { sessions: [], issues: [{ message: 'claude-lister' }] }
    listClaudeSubagentSessions.mockResolvedValue(claude)

    const reply = await requestSubagents(1, 'claude', '/claude/proj/sess.jsonl')

    expect(reply).toMatchObject({ type: 'result', operation: 'subagents', value: claude })
    expect(listClaudeSubagentSessions).toHaveBeenCalledWith({
      parentFilePath: '/claude/proj/sess.jsonl'
    })
    expect(listOmpSubagentSessions).not.toHaveBeenCalled()
  })

  it('lists OMP subagents with the OMP lister only', async () => {
    const omp = { sessions: [], issues: [{ message: 'omp-lister' }] }
    listOmpSubagentSessions.mockResolvedValue(omp)

    const reply = await requestSubagents(2, 'omp', '/omp/slug/sess.jsonl')

    expect(reply).toMatchObject({ type: 'result', operation: 'subagents', value: omp })
    expect(listOmpSubagentSessions).toHaveBeenCalledWith({ parentFilePath: '/omp/slug/sess.jsonl' })
    expect(listClaudeSubagentSessions).not.toHaveBeenCalled()
  })
})
