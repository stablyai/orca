import { afterEach, describe, expect, it } from 'vitest'
import type { OrchestrationDb } from '../orchestration/db'
import { CanvasMessageJournal } from './canvas-message-journal'
import { canvasMessagingFixture } from './canvas-messaging-test-fixture'

const databases: OrchestrationDb[] = []
async function fixture(...args: Parameters<typeof canvasMessagingFixture>) {
  const value = await canvasMessagingFixture(...args)
  databases.push(value.db)
  return value
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

describe('canvas peer messages', () => {
  it.each(['codex', 'claude', 'cursor'] as const)(
    'queues and submits %s only when idle',
    async (provider) => {
      const f = await fixture(provider)
      const message = f.service.send(f.input())
      await f.settle()
      expect(f.journal.get(message.id)).toMatchObject({
        state: 'queued',
        detail: 'Waiting for the agent to become idle.'
      })
      expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
      await f.service.flush()
      expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
      expect(f.runtime.sendTerminalAgentPrompt.mock.calls[0][1]).toContain(message.body)
      expect(f.journal.get(message.id)?.state).toBe('delivered')
      await f.service.flush()
      expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
      expect(f.db.getMessageById(message.id)?.delivery_contract).toBe('audit_only')
    }
  )
  it('discovers peers, retrieves once, and links a reply to its original thread', async () => {
    const f = await fixture()
    expect(f.service.peers('a', 'a')[0]).toMatchObject({
      canvasId: 'canvas',
      self: 'a',
      peers: [{ id: 'b' }]
    })
    const message = f.service.send(f.input())
    await f.settle()
    expect(f.service.inbox('canvas', 'b', 'b')).toHaveLength(1)
    expect(f.service.inbox('canvas', 'b', 'b')).toHaveLength(0)
    const reply = f.service.send({
      ...f.input(),
      paneKey: 'b',
      launchToken: 'b',
      to: 'a',
      replyTo: message.id,
      body: 'Use GET /items.'
    })
    await f.settle()
    expect(reply).toMatchObject({ kind: 'reply', replyTo: message.id, threadId: message.threadId })
    expect(f.journal.get(message.id)?.state).toBe('received')
    expect(f.service.inbox('canvas', 'a', 'a')[0].body).toBe('Use GET /items.')
  })
  it('deduplicates retries but rejects reuse for different content', async () => {
    const f = await fixture()
    const request = f.input()
    const first = f.service.send(request)
    expect(f.service.send(request).id).toBe(first.id)
    expect(() => f.service.send({ ...request, body: 'different' })).toThrow('request ID')
    await f.settle()
    expect(f.journal.history('canvas')).toHaveLength(1)
  })
  it.each([
    { source: 'screen', draft: 'my unfinished request' },
    { source: 'screen-unavailable', draft: '' }
  ])('preserves unavailable or occupied input: %j', async (screen) => {
    const f = await fixture()
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
    f.runtime.readTerminal.mockResolvedValue({ ...screen, composerReady: false })
    const message = f.service.send(f.input())
    await f.settle()
    expect(f.journal.get(message.id)?.state).toBe('queued')
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('pauses queued delivery and resumes without resending', async () => {
    const f = await fixture()
    const message = f.service.send(f.input())
    await f.settle()
    await f.replace((members) =>
      members.map((member) => ({ ...member, collaborationPaused: true }))
    )
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
    await f.service.flush()
    expect(f.service.inbox('canvas', 'b', 'b')).toHaveLength(0)
    expect(() => f.service.send(f.input())).toThrow('paused')
    expect(f.journal.get(message.id)).toMatchObject({
      state: 'queued',
      detail: 'Collaboration is paused.'
    })
    await f.replace((members) =>
      members.map((member) => ({ ...member, collaborationPaused: false }))
    )
    await f.service.flush()
    expect(f.journal.get(message.id)?.state).toBe('delivered')
  })
  it('cancels removed connections and does not give their messages to the inbox', async () => {
    const f = await fixture()
    const message = f.service.send(f.input())
    await f.settle()
    await f.replace((members) => members.map((member) => ({ ...member, peers: [] })))
    expect(f.service.inbox('canvas', 'b', 'b')).toHaveLength(0)
    await f.service.flush()
    expect(f.journal.get(message.id)?.state).toBe('cancelled')
    expect(() => f.service.send(f.input())).toThrow('no longer connected')
  })
  it('never automatically retries an uncertain submission, including after restart', async () => {
    const f = await fixture()
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
    f.runtime.sendTerminalAgentPrompt.mockImplementation(async (_handle, _prompt, options) => {
      await options.beforeWrite?.('pty-b')
      throw new Error('Lost terminal contact after paste')
    })
    const message = f.service.send(f.input())
    await f.settle()
    expect(f.journal.get(message.id)?.state).toBe('unverifiable')
    await f.service.flush()
    expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    f.journal.update(message, 'sending')
    const restored = new CanvasMessageJournal(f.db)
    expect(restored.get(message.id)?.state).toBe('unverifiable')
    expect(restored.pending()).toHaveLength(0)
  })
  it('checks connection again immediately before Enter', async () => {
    const f = await fixture()
    f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
    f.runtime.sendTerminalAgentPrompt.mockImplementation(async (_handle, _prompt, options) => {
      await options.beforeWrite?.('pty-b')
      await f.replace((members) => members.map((member) => ({ ...member, peers: [] })))
      await options.beforeWrite?.('pty-b')
      throw new Error('Should not reach Enter')
    })
    const message = f.service.send(f.input())
    await f.settle()
    expect(f.journal.get(message.id)).toMatchObject({
      state: 'unverifiable',
      detail: 'These agents are no longer connected.'
    })
  })
  it('rejects impersonation, remote terminals, changed sessions, and disabled hooks', async () => {
    const f = await fixture()
    expect(() => f.service.send({ ...f.input(), launchToken: 'wrong' })).toThrow('does not own')
    f.runtime.resolveTerminalPane.mockImplementation((pane) => ({
      handle: pane,
      ptyId: `pty-${pane}`,
      executionHostId: 'ssh:server'
    }))
    expect(() => f.service.send(f.input())).toThrow('execution host')
    f.runtime.resolveTerminalPane.mockImplementation((pane) => ({
      handle: pane,
      ptyId: `pty-${pane}`,
      executionHostId: 'local'
    }))
    f.runtime.getOrchestrationDispatchAuthority.mockReturnValue({ launchTokenHash: 'new-session' })
    expect(() => f.service.send(f.input())).toThrow('session is unverifiable')
    f.runtime.getClientSettings.mockReturnValue({
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    })
    expect(() => f.service.send(f.input())).toThrow('hooks must be enabled')
    expect(f.journal.history('canvas')).toHaveLength(0)
  })
  it('limits loops, cross-thread replies, and message floods', async () => {
    const f = await fixture()
    let previous = f.service.send(f.input())
    await f.settle()
    expect(() => f.service.send({ ...f.input(), replyTo: previous.id })).toThrow('does not belong')
    for (let index = 1; index < 8; index++) {
      const source = previous.target
      previous = f.service.send({
        ...f.input(),
        paneKey: source,
        launchToken: source,
        to: previous.source,
        replyTo: previous.id
      })
      await f.settle()
    }
    expect(() => f.service.send({ ...f.input(), replyTo: previous.id })).toThrow('8-message limit')
    for (let index = 8; index < 20; index++) {
      f.service.send(f.input())
      await f.settle()
    }
    expect(() => f.service.send(f.input())).toThrow('rate limit')
  })
})
