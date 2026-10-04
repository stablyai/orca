import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { DshStructuredSessionAdapter } from './dsh-structured-session-adapter'
import { openDshAcpConnection, type DshAcpConnection } from './dsh-acp-connection'
import { DSH_ACP_PEER } from './dsh-acp-peer.test-fixture'

const adapters: DshStructuredSessionAdapter[] = []
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.closeAll()))
})

const identity: AgentSessionJournalIdentity = {
  sessionId: 'orca-owned-session',
  workspaceId: 'plain-folder',
  hostId: 'local',
  agent: 'dsh-acp',
  providerHandle: { kind: 'opaque', agent: 'dsh-acp', value: 'pending' }
}
async function open(resumeSessionId?: string) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-owned-')))
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  let connection: DshAcpConnection | undefined
  const lifecycle = vi.fn(),
    settlements = vi.fn(),
    spawned = vi.fn()
  const adapter = new DshStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: process.execPath,
      args: ['-e', DSH_ACP_PEER],
      cwd,
      ...(resumeSessionId ? { resumeSessionId } : {})
    }),
    openConnection: async (launch, handlers) => {
      connection = await openDshAcpConnection(launch, handlers)
      return connection
    },
    onLifecycleEvent: lifecycle,
    onDispatchSettledLate: settlements
  })
  adapters.push(adapter)
  const acquired = await adapter.acquire({
    identity,
    fence: 7,
    spawnToken: 'owned-spawn-token',
    onSpawned: spawned,
    events: {
      appendItem: (key, body) => items.push({ identity: key, body }),
      appendTombstone: () => undefined,
      publish: () => undefined
    }
  })
  if (!connection) {
    throw new Error('Fixture did not open its connection')
  }
  const transport = connection
  const send = (text = 'fixture', beforeDispatch?: () => Promise<void>) =>
    adapter.dispatch({
      sessionId: identity.sessionId,
      fence: 7,
      clientMessageId: 'message-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      ...(beforeDispatch ? { beforeDispatch } : {})
    })
  const permission = async () => {
    await vi.waitFor(() => expect(items.some((item) => item.body.kind === 'approval')).toBe(true))
    const item = items.find((item) => item.body.kind === 'approval')
    if (!item) {
      throw new Error('Missing fixture permission')
    }
    return agentJournalItemKey(item.identity)
  }
  const answer = (
    itemId: string,
    optionId: string,
    commit: () => Promise<void> = async () => undefined
  ) =>
    adapter.answerPrompt({
      sessionId: identity.sessionId,
      fence: 7,
      itemId,
      kind: 'approval',
      response: { kind: 'option', optionId },
      commit
    })
  return {
    adapter,
    items,
    transport,
    lifecycle,
    settlements,
    spawned,
    acquired,
    send,
    permission,
    answer
  }
}

describe('official ACP ownership and permission controls with a scripted child', () => {
  it('records the actual child before acquisition and resumes without inventing replay', async () => {
    const { adapter, acquired, spawned, items } = await open('fixture-session')
    expect(spawned).toHaveBeenCalledOnce()
    expect(spawned.mock.calls[0]?.[0]).toEqual(acquired.process)
    expect(acquired.process).toMatchObject({ hostId: 'local', spawnToken: 'owned-spawn-token' })
    expect(acquired.process.processStartTimeMs).toBeTypeOf('number')
    expect(acquired.link).toMatchObject({
      handle: { provider: 'dsh-acp', sessionId: 'fixture-session' },
      origin: 'resumed',
      mintedAtFence: 7
    })
    expect(items).toEqual([])
    await expect(adapter.closeSession(identity.sessionId)).resolves.toBe(true)
  })

  it('commits one offered permission answer once despite concurrent and repeated answers', async () => {
    const fixture = await open()
    const wire = vi.spyOn(fixture.transport, 'respond')
    await fixture.send()
    const itemId = await fixture.permission()
    const invalidCommit = vi.fn()
    await expect(fixture.answer(itemId, 'allow-forever', invalidCommit)).rejects.toThrow('offered')
    expect(invalidCommit).not.toHaveBeenCalled()
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const commit = vi.fn(() => waiting)
    const first = fixture.answer(itemId, 'reject-1', commit)
    await expect(fixture.answer(itemId, 'allow-1')).rejects.toThrow()
    release?.()
    await first
    await vi.waitFor(() =>
      expect(
        fixture.items.some((item) => item.body.kind === 'turn' && item.body.state === 'completed')
      ).toBe(true)
    )
    await expect(fixture.answer(itemId, 'reject-1')).rejects.toThrow()
    expect(commit).toHaveBeenCalledOnce()
    expect(wire.mock.calls.filter(([id]) => id === 700)).toEqual([
      [700, { outcome: { outcome: 'selected', optionId: 'reject-1' } }]
    ])
    const assistant = fixture.items.filter(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )
    expect(assistant.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: 'Hello fixture' }]
    })
    const toolRows = fixture.items.filter((item) => item.body.kind === 'tool-call')
    expect(toolRows[0]?.identity).toEqual(toolRows.at(-1)?.identity)
    expect(toolRows.at(-1)?.body).toMatchObject({ state: 'completed' })
    expect(fixture.items.at(-1)?.body).toMatchObject({
      kind: 'turn',
      outcome: 'success',
      contextUsage: { used: { usedTokens: 12, windowTokens: 100, model: 'fixture-model' } }
    })
  })

  it('cancels a permission claim while its journal commit is waiting', async () => {
    const fixture = await open()
    const wire = vi.spyOn(fixture.transport, 'respond')
    await fixture.send()
    const itemId = await fixture.permission()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const answering = fixture.answer(itemId, 'allow-1', () => blocked)
    const rejection = expect(answering).rejects.toThrow()
    await expect(
      fixture.adapter.cancelTurn({ sessionId: identity.sessionId, fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    release?.()
    await rejection
    expect(wire.mock.calls.filter(([id]) => id === 700)).toEqual([
      [700, { outcome: { outcome: 'cancelled' } }]
    ])
    expect(fixture.items.findLast((item) => item.body.kind === 'approval')?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
  })

  it('refuses a stale lease and revalidates after asynchronous message preparation', async () => {
    const fixture = await open()
    await expect(
      fixture.adapter.dispatch({
        sessionId: identity.sessionId,
        fence: 6,
        clientMessageId: 'stale',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'stale' }] }
      })
    ).rejects.toThrow('matching live owner')
    await expect(
      fixture.send('fixture', async () => {
        await fixture.adapter.closeSession(identity.sessionId)
      })
    ).rejects.toThrow('matching live owner')
    expect(fixture.items).toEqual([])
  })

  it('retains its owner when exit is unverifiable and retries physical close before release', async () => {
    const fixture = await open()
    vi.spyOn(fixture.transport, 'close').mockImplementationOnce(async () => false)
    await expect(fixture.adapter.closeSession(identity.sessionId)).resolves.toBe(false)
    expect(fixture.transport.closed).toBe(false)
    expect(fixture.lifecycle).not.toHaveBeenCalled()
    await expect(
      fixture.adapter.acquire({
        identity,
        fence: 8,
        spawnToken: 'must-not-spawn'
      })
    ).rejects.toThrow('already has an owner')
    expect(fixture.spawned).toHaveBeenCalledOnce()
    await expect(fixture.adapter.closeSession(identity.sessionId)).resolves.toBe(true)
    expect(fixture.transport.closed).toBe(true)
    fixture.adapter.acknowledgeSessionRelease(identity.sessionId)
    await expect(fixture.adapter.closeSession(identity.sessionId)).resolves.toBe(false)
  })

  it('reports an unexpected exit only for the owned acquisition and releases the exact child', async () => {
    const fixture = await open()
    fixture.transport.notify('test/malformed')
    await vi.waitFor(() => expect(fixture.lifecycle).toHaveBeenCalledOnce(), { timeout: 6_000 })
    expect(fixture.lifecycle.mock.calls[0]?.[0]).toMatchObject({
      type: 'ended',
      sessionId: identity.sessionId,
      fence: 7,
      acquisitionGeneration: fixture.acquired.acquisitionGeneration,
      cause: 'unexpected-exit'
    })
    await expect(fixture.adapter.closeSession(identity.sessionId)).resolves.toBe(true)
    fixture.adapter.acknowledgeSessionRelease(identity.sessionId)
    await expect(fixture.adapter.closeSession(identity.sessionId)).resolves.toBe(false)
  })
})
