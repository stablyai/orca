import { createSetupRun } from '../../setup/setup-run'
import type { OrcaRuntimeService } from '../../orca-runtime'
import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../shared/agent-session/structured-agent-session-create'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call, runtimeCalls } from './structured-agent-session-rpc.test-fixture'
import {
  resetStructuredAgentSessionClosesBeforeCreateForTests,
  structuredAgentSessionClosedBeforeCreate
} from './structured-agent-session-close-before-create'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}

let rig: RestTestRig
let raw: { worktreeId: string; tabId: string } | null = null
const retireTab = vi.fn(() => {
  raw = null
  return true
})

beforeEach(async () => {
  mocks.layoutOwnerIsMain = true
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  retireTab.mockClear()
  raw = null
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

function createParams() {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW
  })
}

const create = (overrides: Record<string, unknown> = {}) =>
  call('agentSession.create', createParams(), CLIENT, {
    retireStructuredAgentSessionTabFromSnapshot: retireTab,
    currentLocalStructuredSessionPresentation: () => raw,
    removeCapturedStructuredSessionSavedTabs: vi.fn(),
    ...overrides
  })
const close = () =>
  call('agentSession.close', { sessionId: SESSION }, CLIENT, {
    currentLocalStructuredSessionPresentation: () => raw,
    captureStructuredAgentSessionPresentation: () => ({ raw, saved: [] }),
    retireStructuredAgentSessionTabFromSnapshot: retireTab,
    removeCapturedStructuredSessionSavedTabs: vi.fn()
  })

const refusedAsClosed = {
  ok: true,
  result: {
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      message: 'The chat was closed before it was created.'
    }
  }
}

describe('a close that reaches main before its create', () => {
  it('cancel then create: main refuses the create and makes nothing', async () => {
    expect(await close()).toMatchObject({ ok: true })

    expect(await create()).toMatchObject(refusedAsClosed)
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  })

  it('create then cancel: an ordinary close, and the create still replays', async () => {
    expect(await create()).toMatchObject({ ok: true, result: { ok: true } })
    expect(await close()).toMatchObject({ ok: true })

    expect(await create()).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
  })

  it('a close while the create resolves its workspace refuses it before anything is written', async () => {
    const resolving = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const creating = create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async (params: { envelope: unknown }) => {
        entered.resolve()
        await resolving.promise
        return {
          envelope: params.envelope,
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'git-worktree'
          },
          provider: 'codex',
          agent: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
          runtimeKind: 'native'
        }
      })
    })
    await entered.promise
    await close()
    resolving.resolve()

    expect(await creating).toMatchObject(refusedAsClosed)
    expect(rig.store.getRecord(SESSION)).toBeNull()
  })

  it('a close while the create commits closes the chat as it lands', async () => {
    let closing: Promise<unknown> | undefined
    const result = await create({
      publishStructuredAgentSessionTab: vi.fn(
        async (input: Parameters<OrcaRuntimeService['publishStructuredAgentSessionTab']>[0]) => {
          raw = { worktreeId: 'workspace-1', tabId: `agent-session:${SESSION}` }
          input.capture?.({
            tableId: rig.host.getSessionTabId(SESSION),
            presentation: {
              raw: { worktreeId: 'workspace-1', tabId: `agent-session:${SESSION}` },
              saved: []
            }
          })
          closing = close()
        }
      )
    })
    await closing

    expect(result).toMatchObject(refusedAsClosed)
    expect(retireTab).toHaveBeenCalledWith(SESSION, `agent-session:${SESSION}`, 'workspace-1')
    expect(rig.store.getSessionTabId(SESSION)).toBeNull()
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('a close before a create that fails past commit still closes what it made', async () => {
    let closing: Promise<unknown> | undefined
    const result = await create({
      publishStructuredAgentSessionTab: vi.fn(
        async (input: Parameters<OrcaRuntimeService['publishStructuredAgentSessionTab']>[0]) => {
          raw = { worktreeId: 'workspace-1', tabId: `agent-session:${SESSION}` }
          input.capture?.({
            tableId: rig.host.getSessionTabId(SESSION),
            presentation: {
              raw: { worktreeId: 'workspace-1', tabId: `agent-session:${SESSION}` },
              saved: []
            }
          })
          // Not awaited: the close's stop queues behind this create.
          closing = close()
          await vi.waitFor(() =>
            expect(structuredAgentSessionClosedBeforeCreate(SESSION)).toBe(true)
          )
          throw new Error('tab write failed')
        }
      )
    })

    await closing
    expect(result).toMatchObject(refusedAsClosed)
    expect(rig.store.getRecord(SESSION)).not.toBeNull()
    expect(retireTab).toHaveBeenCalledWith(SESSION, `agent-session:${SESSION}`, 'workspace-1')
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('a close main fails for want of its chat host still refuses the create that follows', async () => {
    setStructuredAgentSessionHost(null)
    expect(await close()).toMatchObject({ ok: false })
    setStructuredAgentSessionHost(rig.host)

    expect(await create()).toMatchObject(refusedAsClosed)
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  })

  it('a close fences pending creates with either layout owner', async () => {
    mocks.layoutOwnerIsMain = false
    await close()
    mocks.layoutOwnerIsMain = true

    expect(await create()).toMatchObject(refusedAsClosed)
  })
})

it.each(['succeeded', 'failed', 'closed', 'missing'] as const)(
  'a linked chat consumes setup %s before committing its first message',
  async (outcome) => {
    const run = createSetupRun(true)
    const entered = Promise.withResolvers<void>()
    const linked = structuredAgentSessionCreateParams({
      ...createParams(),
      sessionId: SESSION,
      worktree: 'id:workspace-1',
      agent: 'codex',
      afterWorktreeSetup: true,
      firstMessage: {
        clientMessageId: 'opening',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Keep this message' }]
        }
      },
      randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
      now: NOW
    })
    const creating = call('agentSession.create', linked, CLIENT, {
      getSetupRun: () => {
        entered.resolve()
        return outcome === 'missing' ? undefined : run
      }
    })
    await entered.promise
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    if (outcome === 'closed') {
      await close()
    }
    run.settle(outcome === 'succeeded' ? { kind: 'succeeded' } : { kind: 'failed', exitCode: 1 })
    if (outcome === 'succeeded') {
      expect(await creating).toMatchObject({
        ok: true,
        result: { ok: true, value: { firstMessage: { clientMessageId: 'opening' } } }
      })
      expect(rig.store.getRecord(SESSION)).not.toBeNull()
      // Once committed, replay is independent of an evicted/restarted setup observer.
      expect(
        await call('agentSession.create', linked, CLIENT, { getSetupRun: () => undefined })
      ).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
    } else {
      expect(await creating).toMatchObject({
        ok: true,
        result: {
          ok: false,
          refusal: {
            code:
              outcome === 'closed'
                ? 'agent_session_operation_invalid'
                : 'agent_session_setup_not_completed'
          }
        }
      })
      expect(rig.store.getRecord(SESSION)).toBeNull()
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      if (outcome !== 'closed') {
        expect(await create()).toMatchObject({ ok: true, result: { ok: true } })
      }
    }
  }
)

it('releases a disconnected linked-create waiter without losing Setup or its opening message', async () => {
  const run = createSetupRun(true)
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  const linked = structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    afterWorktreeSetup: true,
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW
  })
  const runtime = {
    getSetupRun: () => {
      entered.resolve()
      return run
    }
  }
  const pending = call(
    'agentSession.create',
    linked,
    { ...CLIENT, signal: controller.signal },
    runtime
  )
  await entered.promise
  controller.abort(new Error('disconnected'))
  expect(await pending).toMatchObject({ ok: false })
  expect(rig.store.getRecord(SESSION)).toBeNull()
  expect(run.result).toBeUndefined()
  run.settle({ kind: 'succeeded' })
  expect(await call('agentSession.create', linked, CLIENT, runtime)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
})
