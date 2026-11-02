import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../shared/structured-agent-cli-conversation-adoption'
import type { StructuredAgentId } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { assertCliConversationWritersExited } from './structured-agent-cli-writers'
import {
  TerminalIdentityReadContext,
  ptyRecordForPaneKey
} from './terminal/query/terminal-identity-read-context'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
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

  // Every create, resume and acquire runs this check: resolving panes for nothing to leave out, or
  // scanning every terminal for each row, would grow with rows times terminals.
  it('resolves panes only to leave some out, reading the terminals once', async () => {
    const { owner } = identityFixture()
    const run = async (count: number, closingPaneKeys: string[]) => {
      const visits = { count: 0 }
      // Counts every terminal record a lookup reads: a scan of all terminals per row reads each one.
      class CountedMap<V> extends Map<string, V> {
        override get(key: string): V | undefined {
          visits.count += 1
          return super.get(key)
        }
      }
      const leafId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      const indices = Array.from({ length: count }, (_, i) => i)
      // No leaf is bound: every row and closing pane resolves through the terminals' recorded panes.
      const leaves = new CountedMap<RuntimeLeafRecord>()
      const ptys = new CountedMap<RuntimePtyWorktreeRecord>(
        indices.map((i) => [
          `pty-${i}`,
          owner.recordPtyWorktree(`pty-${i}`, 'workspace', { connected: true })
        ])
      )
      const capturePaneOf = () => (record: { ptyId: string }) => {
        const i = Number(record.ptyId.slice(4))
        return { tabId: `tab-${i}`, paneKey: `tab-${i}:${leafId(i)}`, recordedAtGraphSequence: 0 }
      }
      const source = {
        leaves,
        ptys,
        leafKey: (tab: string, id: string) => `${tab}::${id}`,
        capturePaneOf
      }
      let lookups = 0
      // The runtime's resolver: one identity read context for the whole check.
      const ptyResolver = () => {
        const context = new TerminalIdentityReadContext({
          ...source,
          handles: new Map(),
          reverse: new Map(),
          sshTerminals: new Map()
        })
        return (paneKey: string) => {
          lookups += 1
          return ptyRecordForPaneKey(paneKey, source, context)?.ptyId ?? null
        }
      }
      // Rows under keys no terminal is bound to now, which only a scan of the terminals resolves.
      const rows = indices.map((i) => ({ ...row, paneKey: `legacy-${i}` }))
      await assertCliConversationWritersExited(
        {
          rows: () => rows,
          observation: () => ({
            current: () => true,
            presence: async () => 'exited',
            topology: 'pane-owned'
          }),
          ptyResolver
        },
        'claude',
        'conversation',
        closingPaneKeys
      )
      return { lookups, visits: visits.count }
    }
    for (const count of [20, 200]) {
      expect(await run(count, [])).toEqual({ lookups: 0, visits: 0 })
      const closing = await run(count, [`tab-0:${'00000000-0000-4000-8000-000000000000'}`])
      expect(closing.lookups).toBe(count + 1)
      expect(closing.visits).toBeLessThanOrEqual(4 * count)
    }
  })
})
