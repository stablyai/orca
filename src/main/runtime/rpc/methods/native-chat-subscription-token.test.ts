import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { RpcDispatcher } from '../dispatcher'
import type { AgentSessionCurrentRequestsPiece } from '../../../../shared/agent-session-current-requests-wire'
import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../../../shared/agent-session-current-requests-capability'
import {
  questionResourceFixture,
  questionResourceLine
} from '../../../native-chat/message-question-resource.test-fixture'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import type { RpcContext } from '../core'

const sourceHooks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: vi.fn(),
  subscribeNativeChatTranscript: (...args: unknown[]) => {
    sourceHooks.subscribe(...args)
    return Promise.resolve({ unsubscribe: () => {}, watching: true })
  }
}))

import { NATIVE_CHAT_METHODS } from './native-chat'

type Handler = (
  params: unknown,
  ctx: RpcContext,
  emit: (value: unknown) => void
) => Promise<unknown>

function handler(name: string): Handler {
  const method = NATIVE_CHAT_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`${name} not registered`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both methods take (params, ctx[, emit]); the test only calls them with that shape.
  return method.handler as Handler
}

/** One phone connection on a runtime whose subscriptions live in the real registry. */
function phoneConnection(): {
  context: RpcContext
  subscribe: (subscriptionId: string) => Promise<unknown[]>
  unsubscribe: (subscriptionId: string) => Promise<void>
} {
  const registry = new RuntimeSubscriptionRegistry()
  const context: RpcContext = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only touch these registry-backed members and the hook rows.
    runtime: {
      getRuntimeId: () => 'runtime-1',
      ensureStructuredAgentSessionHost: async () => {},
      getAgentProviderSessionRows: () => [],
      registerSubscriptionCleanup: registry.register.bind(registry),
      cleanupSubscription: registry.cleanup.bind(registry),
      cleanupSubscriptionsByPrefix: registry.cleanupByPrefix.bind(registry)
    } as unknown as RpcContext['runtime'],
    connectionId: 'phone-connection',
    clientKind: 'mobile'
  }
  return {
    context,
    subscribe: async (subscriptionId) => {
      const emitted: unknown[] = []
      await handler('nativeChat.subscribe')(
        { agent: 'claude', sessionId: 'session', subscriptionId },
        context,
        (value) => emitted.push(value)
      )
      return emitted
    },
    unsubscribe: async (subscriptionId) => {
      await handler('nativeChat.unsubscribe')({ subscriptionId }, context, () => {})
    }
  }
}

describe('nativeChat subscription tokens on one connection', () => {
  it('keeps two feeds of the same chat apart when each has its own token', async () => {
    const phone = phoneConnection()
    const under = await phone.subscribe('claude:session:under')
    const top = await phone.subscribe('claude:session:top')
    expect(under).toEqual([])
    expect(top).toEqual([])

    await phone.unsubscribe('claude:session:top')
    expect(top).toEqual([{ type: 'end' }])
    expect(under).toEqual([])
  })

  it('ends the older feed when a second one reuses its token', async () => {
    const phone = phoneConnection()
    const older = await phone.subscribe('claude:session')
    const newer = await phone.subscribe('claude:session')
    expect(older).toEqual([{ type: 'end' }])
    expect(newer).toEqual([])
  })
})

const resources: Awaited<ReturnType<typeof questionResourceFixture>>[] = []
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.dispose()
  }
})

async function resourceRpc() {
  const resource = await questionResourceFixture('escaped \\" 😀'.repeat(10_000))
  resources.push(resource)
  const phone = phoneConnection()
  const rpc = new RpcDispatcher({ runtime: phone.context.runtime, methods: NATIVE_CHAT_METHODS })
  const params = {
    agent: 'codex',
    sessionId: 'session',
    transcriptPath: resource.path,
    version: randomUUID()
  }
  const options = (connectionId: string) => ({
    connectionId,
    clientKind: 'mobile' as const,
    pairedDeviceId: connectionId,
    callerScope: { kind: 'mobile' as const },
    clientCapabilities: [AGENT_SESSION_CURRENT_REQUESTS_V2]
  })
  const read = async (connectionId: string, version: string, cursor = 0) => {
    const reply = await rpc.dispatch(
      {
        id: 'read',
        authToken: 'transport-authenticated',
        method: 'nativeChat.currentRequests',
        params: { ...params, version, cursor }
      },
      options(connectionId)
    )
    expect(reply.ok).toBe(true)
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    // SAFETY: the registered production reader returns this wire type; successful dispatch is asserted above.
    return reply.result as AgentSessionCurrentRequestsPiece
  }
  return { resource, phone, rpc, params, options, read }
}

it('reads one complete resource from two authorized connections without subscribing', async () => {
  const f = await resourceRpc()
  const opening = await f.read('phone-a', f.params.version)
  expect(opening.restart).toBe(true)
  const first = await f.read('phone-a', opening.marker.version)
  expect(first.nextCursor).not.toBeNull()
  let json = first.json
  let cursor = first.nextCursor
  while (cursor !== null) {
    const next = await f.read('phone-b', first.marker.version, cursor)
    expect(next.marker).toEqual(first.marker)
    expect(next.restart).toBeUndefined()
    json += next.json
    cursor = next.nextCursor
  }
  expect(JSON.parse(json).asyncQuestions).toMatchObject([{ sourceRowId: 'q1' }])
  expect((await f.read('phone-b', first.marker.version)).json).toBe(first.json)
})

it('refuses missing capability and stale execution-host admission before acquiring the resource', async () => {
  const f = await resourceRpc()
  const ensure = vi.spyOn(f.phone.context.runtime, 'ensureStructuredAgentSessionHost')
  const request = {
    id: 'read',
    authToken: 'transport-authenticated',
    method: 'nativeChat.currentRequests',
    params: f.params
  }
  const noCapability = await f.rpc.dispatch(request, {
    ...f.options('phone-a'),
    clientCapabilities: []
  })
  expect(noCapability).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('capability') }
  })
  const wrongHost = await f.rpc.dispatch(
    {
      ...request,
      expectedRuntimeSource: { sourceId: 'different-source', runtimeId: 'different-host' }
    },
    f.options('phone-b')
  )
  expect(wrongHost).toMatchObject({
    ok: false,
    error: { code: expect.stringMatching(/^runtime_source_/) }
  })
  expect(ensure).not.toHaveBeenCalled()
  const aborted = new AbortController()
  aborted.abort(new Error('view replaced'))
  const replaced = await f.rpc.dispatch(request, {
    ...f.options('phone-a'),
    signal: aborted.signal
  })
  expect(replaced.ok).toBe(false)
})

it('commits exact displayed Cancel IDs through the real resource and refuses foreign or unauthenticated mutations', async () => {
  const f = await resourceRpc()
  const opening = await f.read('phone-a', f.params.version)
  let cursor: number | null = 0
  let json = ''
  while (cursor !== null) {
    const next = await f.read('phone-a', opening.marker.version, cursor)
    json += next.json
    cursor = next.nextCursor
  }
  const displayed = JSON.parse(json).asyncQuestions.map((row: { id: string }) => row.id)
  await appendFile(f.resource.path, questionResourceLine('q2'))
  const cancel = {
    id: 'cancel',
    authToken: 'not-caller-authority',
    method: 'nativeChat.cancelCurrentQuestions',
    params: {
      agent: 'codex',
      sessionId: 'session',
      transcriptPath: f.resource.path,
      ids: displayed
    }
  }
  expect(
    await f.rpc.dispatch(cancel, { ...f.options('phone-a'), pairedDeviceId: undefined })
  ).toMatchObject({ ok: false })
  expect(
    await f.rpc.dispatch(
      { ...cancel, params: { ...cancel.params, sessionId: 'foreign-session' } },
      f.options('phone-b')
    )
  ).toMatchObject({ ok: false })
  expect(await f.rpc.dispatch(cancel, f.options('phone-b'))).toMatchObject({
    ok: true,
    result: { cancelled: true }
  })
  const updated = await f.read('phone-a', opening.marker.version)
  expect(updated.restart).toBe(true)
  const complete = await f.read('phone-a', updated.marker.version)
  expect(JSON.parse(complete.json).asyncQuestions).toMatchObject([{ sourceRowId: 'q2' }])
  expect(JSON.parse(complete.json).asyncQuestions).toHaveLength(1)
})
