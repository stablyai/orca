import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import {
  agentSessionProviderHandleChainHead,
  appendAgentSessionProviderHandleLink
} from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { GROK, GROK_CONFIG_OPTIONS, PROVIDER_SESSION } from './acp-structured-adapter.test-support'
import { ACP_HANDLE_TRANSPORT } from './acp-structured-agent-definitions'
import { restoreJournal } from '../native-chat/agent-session-journal/journal-open'
import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import {
  attachParams,
  openHostRig,
  promptIdOf,
  RESUMES,
  send
} from './acp-structured-host.test-support'

const OMP_NOT_FOUND = z
  .object({
    sessionId: z.string(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown() })
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/omp-v17.0.5-session-load-not-found.json', import.meta.url),
        'utf8'
      )
    )
  )

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

const FRESH = 'grok-fresh-session'
const FRESH_2 = 'grok-second-fresh-session'
const keyOf = (nativeId: string) =>
  agentSessionProviderHandleKey({ transport: ACP_HANDLE_TRANSPORT, agent: 'grok', nativeId })

type Lost = Map<string, { code: number; message: string; data?: unknown }>

function sessionsLost(loads: string[], lost: Lost, first = PROVIDER_SESSION) {
  const opened = [first, FRESH, FRESH_2]
  return (agent: AcpScriptedAgent) => {
    agent.on('session/new', (frame) => {
      agent.reply(frame, {
        sessionId: opened.shift() ?? 'grok-unexpected-session',
        configOptions: GROK_CONFIG_OPTIONS
      })
    })
    agent.on('session/load', (frame) => {
      const { sessionId } = z.object({ sessionId: z.string() }).parse(frame.params)
      loads.push(sessionId)
      const failure = lost.get(sessionId)
      if (failure) {
        agent.fail(frame, failure.code, failure.message, failure.data)
      } else {
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      }
    })
  }
}

async function openRestoreRig(
  code: number,
  message: string,
  saved: { sessionId: string; data?: unknown } = { sessionId: PROVIDER_SESSION }
) {
  const loads: string[] = []
  const lost: Lost = new Map([[saved.sessionId, { code, message, data: saved.data }]])
  const resolver: { resolve: ReturnType<typeof createAcpStructuredLaunchResolver> | null } = {
    resolve: null
  }
  const opened = await openHostRig({
    initialize: RESUMES,
    script: sessionsLost(loads, lost, saved.sessionId),
    deps: {
      resolveLaunch: (input) => {
        if (!resolver.resolve) {
          throw new Error('launch resolver not ready')
        }
        return resolver.resolve(input)
      },
      readLaunch: (identity) => {
        if (!resolver.resolve) {
          throw new Error('launch resolver not ready')
        }
        return resolver.resolve({ identity })
      }
    }
  })
  const { rig, host, store, journalDatabase } = opened
  resolver.resolve = createAcpStructuredLaunchResolver(GROK, {
    store,
    readJournal: (sessionId) => restoreJournal(journalDatabase.db, sessionId),
    resolveWorkspacePath: async () => '/workspace',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    resolveCommand: () => '/fake/grok'
  })
  const warnings = async () => {
    await host.flushStreamedEvents(SESSION)
    return (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items.filter(
      (row) =>
        row.body.kind === 'status' &&
        readAgentSessionFailureFact(row.body.failure)?.kind === 'sessionNotRestored'
    )
  }
  const exchange = async (text: string, reply: string, providerSession: string) => {
    await send(host, text)
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({ sessionId: providerSession })
    rig.child().agent.notify('session/update', {
      sessionId: providerSession,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      _meta: { promptId: promptIdOf(prompt) }
    })
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
  }
  return { ...opened, loads, lost, warnings, exchange }
}

describe('a saved Grok session Grok cannot reopen', () => {
  it.each([
    ['reports it missing', -32002, 'Resource not found', 'savedConversationMissing', {}],
    ['cannot read it', -32603, 'session file is corrupt', undefined, {}],
    [
      'answers with the internal error OMP records for a missing session',
      OMP_NOT_FOUND.error.code,
      OMP_NOT_FOUND.error.message,
      'savedConversationMissing',
      { sessionId: OMP_NOT_FOUND.sessionId, data: OMP_NOT_FOUND.error.data }
    ]
  ] as const)(
    'keeps the chat on that session when the agent %s, opening no other, and keeps its saved context',
    async (_label, code, message, failure, recorded) => {
      const saved = { sessionId: PROVIDER_SESSION, ...recorded }
      const { host, store, fence, loads, warnings, ready, exchange, messages, rig } =
        await openRestoreRig(code, message, saved)
      expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
      await ready()
      await exchange('remember 42', 'noted', saved.sessionId)
      await host.close(SESSION, 'user-close')
      const chain = structuredClone(store.getRecord(SESSION)?.providerHandleChain)

      expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
      const q = await send(host, 'still there?')
      const settled = async () =>
        (await host.journalSnapshot(SESSION)).submissions.find((row) => row.clientMessageId === q)
      await vi.waitFor(async () => expect((await settled())?.dispatchState).toBe('rejected'))
      if (failure) {
        expect((await settled())?.rejection).toMatchObject({ kind: failure })
      } else {
        expect((await settled())?.rejection).not.toMatchObject({
          kind: 'savedConversationMissing'
        })
      }
      // The reopened child neither opened another session nor received Q.
      expect(rig.sent('session/prompt')).toEqual([])
      expect(loads).toEqual([saved.sessionId])
      expect(rig.sent('session/new')).toEqual([])
      expect(store.getRecord(SESSION)?.providerHandleChain).toEqual(chain)
      expect(await warnings()).toEqual([])
      expect(await messages()).toEqual(expect.arrayContaining(['remember 42', 'noted']))

      const { cursor } = await host.journalSnapshot(SESSION)
      const context = await host.continuationContext({
        sessionId: SESSION,
        workspaceId: store.getRecord(SESSION)!.location.workspaceId,
        expectedCursor: { epoch: cursor.epoch, sequence: 0 }
      })
      expect(context).toMatchObject({ status: 'current' })
      expect(JSON.stringify(context)).toContain('remember 42')
      await host.close(SESSION, 'user-close')
    }
  )
})

describe('a created Grok session Grok reports missing on the first reopen', () => {
  it('supersedes it silently when nothing was exchanged on it', async () => {
    const { host, store, fence, loads, warnings, ready } = await openRestoreRig(
      -32002,
      'Resource not found'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()

    expect(loads).toEqual([PROVIDER_SESSION])
    const chain = store.getRecord(SESSION)?.providerHandleChain ?? []
    expect(chain).toHaveLength(1)
    const head = agentSessionProviderHandleChainHead(chain)
    expect(head).toMatchObject({
      origin: 'created',
      handle: { nativeId: FRESH },
      supersedesKey: keyOf(PROVIDER_SESSION)
    })
    expect(head?.replaces).toBeUndefined()
    expect(await warnings()).toEqual([])
    await host.close(SESSION, 'user-close')
  })
})

describe('a chat whose saved chain already records a lost session', () => {
  it('writes the warning once on the next start, and never again', async () => {
    const { host, store, fence, loads, warnings, ready } = await openRestoreRig(
      -32603,
      'session file is corrupt'
    )
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await ready()
    await host.close(SESSION, 'user-close')
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      providerHandleChain: appendAgentSessionProviderHandleLink(record.providerHandleChain, {
        linkId: 'saved-replacement',
        handle: { transport: ACP_HANDLE_TRANSPORT, agent: 'grok', nativeId: FRESH },
        origin: 'created',
        mintedAtFence: fence(),
        observedAt: 1,
        replaces: { key: keyOf(PROVIDER_SESSION), reason: 'restore-failed', replacedAt: 1 }
      })
    }))

    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([FRESH])
    expect(await warnings()).toHaveLength(1)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await ready()
    expect(loads).toEqual([FRESH, FRESH])
    expect(await warnings()).toHaveLength(1)
    await host.close(SESSION, 'user-close')
  })
})
