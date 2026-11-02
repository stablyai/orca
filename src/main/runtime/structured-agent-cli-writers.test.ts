import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../shared/structured-agent-cli-conversation-adoption'
import type { StructuredAgentId } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { assertCliConversationWritersExited } from './structured-agent-cli-writers'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'
import { identityFixture } from './terminal/query/terminal-identity.test-fixture'

const row: AgentStatusIpcPayload = {
  paneKey: 'source',
  worktreeId: 'workspace',
  connectionId: null,
  agentType: 'claude',
  receivedAt: 1,
  stateStartedAt: 1,
  state: 'done',
  prompt: '',
  providerSession: { key: 'session_id', id: 'conversation' }
}
const conflict = {
  refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
}
function check(
  rows: AgentStatusIpcPayload[],
  verdict: AgentProcessVerdict | null,
  current = true,
  agent: StructuredAgentId = 'claude'
) {
  return assertCliConversationWritersExited(
    {
      rows: () => rows,
      observation: () => ({
        current: () => current,
        presence: async () => verdict,
        topology: 'shared'
      })
    },
    agent,
    'conversation'
  )
}

describe('canonical status store conversation admission', () => {
  it.each(Object.keys(CLI_CONVERSATION_ADOPTING_AGENTS))(
    'refuses a verified live %s holder, including shared topology',
    async (agent) => {
      const chats = CLI_CONVERSATION_ADOPTING_AGENTS
      const entry = Object.entries(chats).find(([name]) => name === agent)
      if (!entry) {
        throw new Error('missing agent')
      }
      for (const chat of entry[1]) {
        await expect(
          assertCliConversationWritersExited(
            {
              rows: () => [{ ...row, agentType: agent }],
              observation: () => ({
                current: () => true,
                presence: async () => 'live',
                topology: 'shared'
              })
            },
            chat,
            'conversation'
          )
        ).rejects.toMatchObject(conflict)
      }
    }
  )

  it.each(['exited', 'unverifiable', null] as const)(
    'admits a %s verdict, including a current Codex hook with no recorded process',
    async (verdict) => {
      await expect(check([row], verdict)).resolves.toBeUndefined()
      await expect(
        check(
          [{ ...row, paneKey: 'other:leaf', agentType: 'codex', state: 'working' }],
          verdict,
          true,
          'codex'
        )
      ).resolves.toBeUndefined()
    }
  )

  it('admits absent, structured, foreign-host and other-conversation rows', async () => {
    await expect(check([], 'live')).resolves.toBeUndefined()
    await expect(
      check(
        [
          { ...row, structuredHost: 'owned' },
          { ...row, connectionId: 'ssh' },
          { ...row, providerSession: { key: 'session_id', id: 'another' } }
        ],
        'live'
      )
    ).resolves.toBeUndefined()
  })

  it('drops a replaced observation while a probe is pending, and admits missing observations', async () => {
    await expect(check([row], 'live', false)).resolves.toBeUndefined()
    const observation = vi.fn(() => null)
    await expect(
      assertCliConversationWritersExited(
        { rows: () => [row], observation },
        'claude',
        'conversation'
      )
    ).resolves.toBeUndefined()
  })

  // The source terminal's own agent stops with the close that follows, so it is no other writer.
  it('leaves out the panes the caller closes, by key or by their PTY, unless a shared server holds it', async () => {
    const ptys: Record<string, string> = { 'tab-1:leaf': 'pty-1', 'legacy-1': 'pty-1' }
    const admit = (
      rows: AgentStatusIpcPayload[],
      topology: 'pane-owned' | 'shared' = 'pane-owned'
    ) =>
      assertCliConversationWritersExited(
        {
          rows: () => rows,
          observation: () => ({ current: () => true, presence: async () => 'live', topology }),
          ptyResolver: () => (paneKey) => ptys[paneKey] ?? null
        },
        'claude',
        'conversation',
        ['tab-1:leaf']
      )
    await expect(admit([{ ...row, paneKey: 'tab-1:leaf' }])).resolves.toBeUndefined()
    await expect(admit([{ ...row, paneKey: 'legacy-1' }])).resolves.toBeUndefined()
    await expect(admit([{ ...row, paneKey: 'tab-2:leaf' }])).rejects.toMatchObject(conflict)
    await expect(admit([{ ...row, paneKey: 'tab-1:leaf' }], 'shared')).rejects.toMatchObject(
      conflict
    )
  })

  // Many terminals can name one conversation: a check starts only a few probes at once, and none
  // once a holder refused.
  it.each([20, 200])('probes %i matching rows a few at a time, stopping at a holder', async (m) => {
    let started = 0
    let inFlight = 0
    let peak = 0
    const pending: ((verdict: AgentProcessVerdict) => void)[] = []
    const observation = (): CliWriterObservation => ({
      current: () => true,
      topology: 'pane-owned',
      presence: () => {
        started += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        return new Promise((resolve) => {
          pending.push((verdict) => {
            inFlight -= 1
            resolve(verdict)
          })
        })
      }
    })
    const flush = async () => {
      for (let tick = 0; tick < 10; tick += 1) {
        await Promise.resolve()
      }
    }
    const answer = async (verdict: AgentProcessVerdict) => {
      for (const reply of pending.splice(0)) {
        reply(verdict)
      }
      await flush()
    }
    const rows = [
      ...Array.from({ length: m }, (_, i) => ({ ...row, paneKey: `pane-${i}` })),
      ...Array.from({ length: m }, (_, i) => ({
        ...row,
        paneKey: `other-${i}`,
        providerSession: { key: 'session_id' as const, id: 'another' }
      })),
      ...Array.from({ length: m }, (_, i) => ({
        ...row,
        paneKey: `chat-${i}`,
        structuredHost: 'owned' as const
      }))
    ]
    const check = () =>
      assertCliConversationWritersExited(
        { rows: () => rows, observation },
        'claude',
        'conversation'
      )

    // Every row admits: each matching row is probed once, never more than 8 at a time.
    const admitted = check()
    while (pending.length > 0) {
      await answer('exited')
    }
    await expect(admitted).resolves.toBeUndefined()
    expect({ started, peak }).toEqual({ started: m, peak: 8 })

    started = 0
    peak = 0
    const refused = check()
    void refused.catch(() => undefined)
    const first = pending.shift()
    first?.('live')
    await flush()
    await expect(refused).rejects.toMatchObject(conflict)
    const startedAtRefusal = started
    await answer('exited')
    expect(started).toBe(startedAtRefusal)
    expect(startedAtRefusal).toBeLessThanOrEqual(8)
  })

  // Every create, resume and acquire runs this check: resolving panes for nothing to leave out, or
  // scanning every terminal for each row, would grow with rows times terminals.
  it('resolves panes only to leave some out, through one look at the terminals', async () => {
    const leafId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    for (const count of [20, 200]) {
      const { runtime, owner } = identityFixture({
        readHookCliWriterObservation: () => ({
          current: () => true,
          topology: 'pane-owned',
          presence: async () => 'exited'
        })
      })
      for (let i = 0; i < count; i += 1) {
        owner.recordPtyWorktree(`pty-${i}`, 'workspace', {
          paneKey: `tab-${i}:${leafId(i)}`,
          connected: true
        })
      }
      // Rows under keys no terminal is bound to now, which only a look at the terminals resolves.
      vi.spyOn(runtime, 'getAgentProviderSessionRows').mockReturnValue(
        Array.from({ length: count }, (_, i) => ({ ...row, paneKey: `legacy-${i}` }))
      )
      const contexts = vi.spyOn(runtime, 'createTerminalIdentityReadContext')
      // A lookup with no shared look walks every terminal and leaf by key, per pane.
      const scans = [vi.spyOn(owner.ptysById, 'keys'), vi.spyOn(owner.leaves, 'keys')]
      const scanned = () => scans.reduce((sum, scan) => sum + scan.mock.calls.length, 0)

      await runtime.assertStructuredAdoptionTerminalWritersExited('claude', 'conversation')
      expect({ contexts: contexts.mock.calls.length, scans: scanned() }).toEqual({
        contexts: 0,
        scans: 0
      })
      await runtime.assertStructuredAdoptionTerminalWritersExited('claude', 'conversation', [
        `tab-0:${leafId(0)}`
      ])
      expect({ contexts: contexts.mock.calls.length, scans: scanned() }).toEqual({
        contexts: 1,
        scans: 0
      })
    }
  })
})
