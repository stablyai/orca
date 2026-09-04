import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { switchProviderFingerprintFields } from './structured-agent-session-provider-switch'

const CALLER = { callerKey: 'client-1' }

function envelope(
  method: string,
  fields: Record<string, unknown>,
  expectedRuntimeFence: number | null
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let spawns = 0

function grokAttach(): AgentSessionAttachParams {
  return hostTestAttachParams(null, {
    provider: 'grok',
    agent: 'grok',
    accountHome: { variable: 'GROK_HOME', path: '/home/dev/.grok' },
    providerHandle: { kind: 'grok', sessionId: 'grok-sess' }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-switch-'))
  resetHostTestOperationIds()
  spawns = 0
  acquire = vi.fn(async ({ identity, fence }) => {
    const spawnToken = store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    const handle =
      identity.agent === 'claude'
        ? { provider: 'claude' as const, sessionId: 'claude-sess', leafUuid: null }
        : { provider: 'grok' as const, sessionId: 'grok-sess' }
    return {
      process: {
        hostId: 'local',
        pid: 4242 + spawns,
        processStartTimeMs: 1_700_000_000_000,
        spawnToken
      },
      link: {
        linkId: `link-${fence}-${identity.agent}`,
        handle,
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  closeSession = vi.fn(async () => true)
  dispatch = vi.fn(async (): Promise<AgentSessionDispatchOutcome> => ({
    state: 'accepted',
    providerIdentity: { provider: 'legacy', agent: 'grok', sessionId: 'grok-sess', recordId: 'r1' }
  }))
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  setOption = vi.fn(async () => ({ model: 'sonnet' }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch,
      cancelTurn,
      answerPrompt: vi.fn(async () => undefined),
      setOption,
      closeSession,
      releaseAcquisition: ({ sessionId }) => closeSession(sessionId)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => {
      spawns += 1
      return `spawn-${spawns}`
    },
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('switchProvider', () => {
  function switchToClaude() {
    return {
      envelope: envelope(
        'agentSession.switchProvider',
        { agent: 'claude', model: 'sonnet' },
        store.getRecord(SESSION)!.lease.runtimeFence
      ),
      agent: 'claude' as const,
      provider: 'claude' as const,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/dev/.claude' },
      model: 'sonnet'
    }
  }

  it('keeps the original owner identity when child exit is unproven', async () => {
    await host.attach(CALLER, grokAttach())
    const original = store.getRecord(SESSION)
    closeSession.mockResolvedValue(false)
    const params = switchToClaude()
    expect((await host.switchProvider(CALLER, params)).ok).toBe(false)
    expect((await host.switchProvider(CALLER, params)).ok).toBe(false)
    expect(store.getRecord(SESSION)?.lease.ownerProcess).toEqual(original?.lease.ownerProcess)
    expect(store.getRecord(SESSION)?.provider).toBe('grok')
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('does not repeat a completed switch after another provider switch', async () => {
    await host.attach(CALLER, grokAttach())
    const first = switchToClaude()
    expect((await host.switchProvider(CALLER, first)).ok).toBe(true)
    expect(
      (
        await host.switchProvider(CALLER, {
          envelope: envelope(
            'agentSession.switchProvider',
            { agent: 'grok' },
            store.getRecord(SESSION)!.lease.runtimeFence
          ),
          agent: 'grok',
          provider: 'grok',
          accountHome: { variable: 'GROK_HOME', path: '/home/dev/.grok' }
        })
      ).ok
    ).toBe(true)
    closeSession.mockClear()
    acquire.mockClear()
    expect(await host.switchProvider(CALLER, first)).toMatchObject({ ok: true, replayed: true })
    expect(store.getRecord(SESSION)?.provider).toBe('grok')
    expect(closeSession).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('updates the original subscription fence and carries context without displaying it', async () => {
    await host.attach(CALLER, grokAttach())
    const frames: AgentSessionSubscribeEvent[] = []
    host.subscribe({ id: 'chat', sessionId: SESSION, emit: (frame) => frames.push(frame) })
    await host.send(CALLER, {
      envelope: envelope(
        'agentSession.send',
        { body: hostTestMessage('Remember the blue widget') },
        store.getRecord(SESSION)!.lease.runtimeFence
      ),
      body: hostTestMessage('Remember the blue widget')
    })
    expect((await host.switchProvider(CALLER, switchToClaude())).ok).toBe(true)
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    expect(frames.at(-1)).toMatchObject({ fence })
    dispatch.mockImplementation(async ({ clientMessageId }) => ({
      state: 'accepted',
      providerIdentity: {
        provider: 'legacy',
        agent: 'claude',
        sessionId: 'claude-sess',
        recordId: clientMessageId
      }
    }))
    const body = hostTestMessage('What color was it?')
    expect(
      (
        await host.send(CALLER, {
          envelope: envelope('agentSession.send', { body }, fence),
          body
        })
      ).ok
    ).toBe(true)
    const sent = dispatch.mock.calls.at(-1)![0].body
    expect(JSON.stringify(sent)).toContain('Remember the blue widget')
    expect(sent.blocks.at(-1)).toEqual(body.blocks[0])
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(JSON.stringify(history)).not.toContain('Continue work from the prior Orca session')
    const next = hostTestMessage('Thanks')
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: next }, fence),
      body: next
    })
    expect(dispatch.mock.calls.at(-1)![0].body).toEqual(next)
    expect(
      (
        await host.setOption(CALLER, {
          envelope: envelope('agentSession.setOption', { key: 'effort', value: 'high' }, fence),
          key: 'effort',
          value: 'high'
        })
      ).ok
    ).toBe(true)
  })

  it('refuses a rejected model instead of claiming the switch succeeded', async () => {
    await host.attach(CALLER, grokAttach())
    setOption.mockRejectedValueOnce(new AgentSessionOptionRejectedError('Model unavailable'))
    const frames: AgentSessionSubscribeEvent[] = []
    host.subscribe({ id: 'retry-chat', sessionId: SESSION, emit: (frame) => frames.push(frame) })
    const result = await host.switchProvider(CALLER, switchToClaude())
    expect(result).toMatchObject({ ok: false })
    expect(frames.at(-1)).toMatchObject({ fence: store.getRecord(SESSION)!.lease.runtimeFence })
    expect((await host.switchProvider(CALLER, switchToClaude())).ok).toBe(true)
  })

  it('kills the grok child, starts claude, and keeps the journal on the same session', async () => {
    const created = await host.attach(CALLER, grokAttach())
    expect(created.ok).toBe(true)
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: hostTestMessage('hi') }, fence),
      body: hostTestMessage('hi')
    })
    const switched = await host.switchProvider(CALLER, {
      envelope: envelope(
        'agentSession.switchProvider',
        switchProviderFingerprintFields({ agent: 'claude', model: 'sonnet' }),
        fence
      ),
      agent: 'claude',
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      model: 'sonnet'
    })
    expect(switched).toMatchObject({ ok: true, replayed: false, value: { agent: 'claude' } })
    expect(closeSession).toHaveBeenCalledOnce()
    expect(acquire.mock.calls.map((call) => call[0]?.identity.agent)).toEqual(['grok', 'claude'])
    expect(acquire.mock.calls[1]?.[0]?.identity.providerHandle).toEqual({
      kind: 'opaque',
      agent: 'claude',
      value: 'pending'
    })
    const record = store.getRecord(SESSION)
    expect(record?.provider).toBe('claude')
    expect(record?.providerHandleChain).toHaveLength(1)
    expect(record?.providerHandleChain[0]?.handle).toEqual({
      provider: 'claude',
      sessionId: 'claude-sess',
      leafUuid: null
    })
    expect(host.listSessionTabs().find((tab) => tab.sessionId === SESSION)?.agent).toBe('claude')
    const items = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(items.ok).toBe(true)
    if (items.ok) {
      expect(items.page.items.some((item) => item.body.kind === 'message')).toBe(true)
      expect(
        items.page.items.some(
          (item) => item.body.kind === 'status' && item.body.text.includes('Claude')
        )
      ).toBe(true)
    }
    expect(setOption).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'model', value: 'sonnet' })
    )
  })

  it('replays a completed switch instead of killing the new child', async () => {
    const created = await host.attach(CALLER, grokAttach())
    expect(created.ok).toBe(true)
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    const params = {
      envelope: envelope(
        'agentSession.switchProvider',
        switchProviderFingerprintFields({ agent: 'claude' }),
        fence
      ),
      agent: 'claude' as const,
      provider: 'claude' as const,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/dev/.claude' }
    }
    expect((await host.switchProvider(CALLER, params)).ok).toBe(true)
    closeSession.mockClear()
    acquire.mockClear()
    const replayed = await host.switchProvider(CALLER, params)
    expect(replayed).toMatchObject({ ok: true, replayed: true })
    expect(closeSession).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })
})
