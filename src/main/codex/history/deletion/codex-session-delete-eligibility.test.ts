import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canDeleteCodexSession } from './codex-session-delete-eligibility'

const { snapshot, presence, ownership } = vi.hoisted(() => ({
  snapshot: vi.fn(),
  presence: vi.fn(),
  ownership: vi.fn()
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: {
    getStatusSnapshot: snapshot,
    checkAgentPresence: presence
  }
}))
vi.mock('../../../ai-vault/structured-session-ownership', () => ({
  assertLegacyAiVaultResumeAllowed: ownership
}))

const SESSION = '019f0000-1111-7222-8333-000000000001'
const row = {
  agentType: 'codex',
  connectionId: null,
  paneKey: 'pane',
  providerSession: { id: SESSION }
}
beforeEach(() => {
  vi.resetAllMocks()
  snapshot.mockReturnValue([row])
})

describe('Codex deletion ownership', () => {
  it.each(['live', 'unverifiable', null])('refuses a %s owner', async (verdict) => {
    presence.mockResolvedValue(verdict)
    expect(await canDeleteCodexSession(SESSION, '/history/rollout.jsonl')).toBe(false)
  })
  it('accepts a certified exit, including an ended retained session', async () => {
    presence.mockResolvedValue('exited')
    expect(await canDeleteCodexSession(SESSION, '/history/rollout.jsonl')).toBe(true)
    expect(presence).toHaveBeenCalledWith('pane', { includeEnded: true })
  })
  it('refuses native chat ownership before probing terminal presence', async () => {
    ownership.mockImplementation(() => {
      throw new Error('agent_session_conflict')
    })
    expect(await canDeleteCodexSession(SESSION, '/history/rollout.jsonl')).toBe(false)
    expect(presence).not.toHaveBeenCalled()
  })
  it('does not confuse another host or provider session with the selected session', async () => {
    snapshot.mockReturnValue([
      { ...row, connectionId: 'ssh:box' },
      { ...row, providerSession: { id: 'other-session' } }
    ])
    expect(await canDeleteCodexSession(SESSION, '/history/rollout.jsonl')).toBe(true)
    expect(presence).not.toHaveBeenCalled()
  })
})
