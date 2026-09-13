import { afterEach, describe, expect, it } from 'vitest'
import { normalizePromptField } from '../../../shared/agent-status-field-normalization'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server'
import { canvasMessagingFixture } from './canvas-messaging-test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close()
  }
})

async function delivered() {
  const f = await canvasMessagingFixture()
  cleanup.push(() => {
    f.service.stop()
    f.db.close()
  })
  f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
  const message = f.service.send(f.input())
  await f.settle()
  const prompt = normalizePromptField(f.runtime.sendTerminalAgentPrompt.mock.calls[0][1])
  const event: EnrichedAgentHookEventPayload = {
    paneKey: 'b',
    worktreeId: 'folder-workspace',
    connectionId: null,
    source: 'codex',
    launchToken: 'b',
    providerSession: { key: 'session_id', id: 'session-b' },
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    hasExplicitPrompt: true,
    hookEventName: 'UserPromptSubmit',
    payload: { state: 'working', prompt, agentType: 'codex' }
  }
  f.service.observeAgentHook(event)
  f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'working' })
  const final: EnrichedAgentHookEventPayload = {
    ...event,
    hasExplicitPrompt: false,
    hookEventName: 'Stop',
    payload: {
      state: 'done',
      prompt,
      agentType: 'codex',
      lastAssistantMessage: 'Only this answer belongs to the canvas question.'
    }
  }
  return { ...f, message, event, final }
}

describe('canvas reply isolation', () => {
  it('does not duplicate a reply explicitly sent by the agent', async () => {
    const f = await delivered()
    f.service.send({
      ...f.input(),
      paneKey: 'b',
      launchToken: 'b',
      to: 'a',
      replyTo: f.message.id,
      body: 'Explicit answer'
    })
    f.service.observeAgentHook(f.final)
    await f.settle()
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([
      expect.objectContaining({ body: 'Explicit answer' })
    ])
  })
  it.each([
    { isReplay: true },
    { restoredUnconfirmed: true as const },
    { toolAgentId: 'child-agent' },
    { claudeLeadBoundaryChildOnly: true as const },
    { providerSessionOnly: true },
    { connectionId: 'ssh:host' },
    { worktreeId: 'another-workspace' },
    { providerSession: { key: 'session_id' as const, id: 'another-session' } },
    { launchToken: 'another-launch' },
    { source: 'cursor' as const }
  ])('ignores a final answer with unrelated provenance: %j', async (change) => {
    const f = await delivered()
    f.service.observeAgentHook({ ...f.final, ...change })
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
  })
  it.each([
    { interrupted: true },
    { sessionBoundary: true },
    { lastAssistantMessageIsToolOutput: true },
    { state: 'working' as const }
  ])('never treats interrupted or non-final output as an answer: %j', async (change) => {
    const f = await delivered()
    f.service.observeAgentHook({ ...f.final, payload: { ...f.final.payload, ...change } })
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
  })
  it('holds a captured answer while paused and returns it once after resume', async () => {
    const f = await delivered()
    await f.replace((members) =>
      members.map((member) => ({ ...member, collaborationPaused: true }))
    )
    f.service.observeAgentHook(f.final)
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
    await f.replace((members) =>
      members.map((member) => ({ ...member, collaborationPaused: false }))
    )
    await f.service.flush()
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([
      expect.objectContaining({ replyTo: f.message.id, body: f.final.payload.lastAssistantMessage })
    ])
    await f.service.flush()
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
  })
  it('drops a captured answer when its connection is removed, even if reconnected later', async () => {
    const f = await delivered()
    await f.replace((members) => members.map((member) => ({ ...member, peers: [] })))
    f.service.observeAgentHook(f.final)
    await f.replace((members) =>
      members.map((member) => ({ ...member, peers: [member.nodeId === 'a' ? 'b' : 'a'] }))
    )
    await f.service.flush()
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
  })
  it('does not forward a late answer after Orca stops tracking the turn', async () => {
    const f = await delivered()
    f.service.stop()
    f.service.observeAgentHook(f.final)
    expect(f.service.inbox('canvas', 'a', 'a')).toEqual([])
  })
})
