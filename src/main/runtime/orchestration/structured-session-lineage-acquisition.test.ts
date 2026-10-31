import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  createSessionCallerHarness,
  sessionRecord,
  SESSION_X,
  SESSION_Y
} from '../rpc/orchestration-session-caller-test-fixture'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createStructuredWorkerReadContext,
  holdStructuredWorker,
  resolveStructuredWorkerAuthority,
  structuredWorkerSession
} from '../structured-worker-authority'
import {
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  createLineageRunningSessionResolver,
  resolveLineageRunningSession,
  type AgentSessionRecordReader
} from './structured-session-lineage'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

afterEach(() => vi.restoreAllMocks())

function record(id: string, next?: string): AgentSessionConversationView {
  const base = agentSessionConversationView(sessionRecord(id))
  return next === undefined
    ? base
    : {
        ...base,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          callerKey: 'lineage-fixture',
          phase: 'committed',
          operationId: `clear-${id}`,
          replacementSessionId: next
        }
      }
}

function reader(records: readonly AgentSessionConversationView[], thrown = '') {
  const byId = new Map(records.map((value) => [value.sessionId, value]))
  const reads: string[] = []
  const store: AgentSessionRecordReader = {
    getRecord: (id) => {
      reads.push(id)
      if (id === thrown) {
        throw new Error('unreadable record')
      }
      return byId.get(id) ?? null
    },
    listRecords: () => {
      throw new Error('unrelated inventory must not be acquired')
    }
  }
  return { store, reads }
}

it('preserves the entire root-relative authority result for shared, failed and cyclic captured chains in either order', () => {
  const base = record('pending', 'C')
  const committed = base.conversationCommand!
  const records: AgentSessionConversationView[] = [
    record('A', 'B'),
    record('B', 'C'),
    record('C'),
    record('D', 'B'),
    record('missing', 'absent'),
    record('throwing', 'throws'),
    record('self', 'self'),
    record('X', 'Y'),
    record('Y', 'X'),
    record('prefix', 'X'),
    record('falsy', ''),
    { ...base, conversationCommand: { ...committed, phase: 'prepared' as const } },
    { ...record('remote'), location: { ...record('remote').location, executionHostId: 'ssh:box' } },
    {
      ...record('wsl'),
      provider: 'codex' as const,
      location: { ...record('wsl').location, wslDistro: 'Ubuntu' }
    }
  ]
  const roots = [...records.map((value) => value.sessionId), 'absent', 'throws']
  for (const reversed of [false, true]) {
    const baseline = reader(structuredClone(records), 'throws')
    const candidate = reader(structuredClone(records), 'throws')
    const resolve = createLineageRunningSessionResolver(candidate.store)
    for (const root of reversed ? roots.toReversed() : roots) {
      expect(resolve(root)).toEqual(resolveLineageRunningSession(baseline.store, root))
      expect(resolve(root)).toEqual(resolveLineageRunningSession(baseline.store, root))
    }
    expect(new Set(candidate.reads).size).toBe(candidate.reads.length)
    const result = resolve('A')
    if (Array.isArray(result.lineage)) {
      result.lineage.push('caller-mutation')
    }
    expect(resolve('A').lineage).toEqual(['A', 'B', 'C'])
    expect(resolve('B').lineage).toEqual(['B', 'C'])
  }
  expect(createLineageRunningSessionResolver(null)('A')).toEqual(
    resolveLineageRunningSession(null, 'A')
  )
})

it('charges raw/suffix discovery once, output paths separately, and reacquires on a new capture at N/10N', () => {
  for (const population of [3, 30]) {
    for (const ending of ['terminal', 'missing', 'cycle'] as const) {
      const chain = Array.from({ length: population }, (_, i) =>
        record(`node-${i}`, i + 1 < population ? `node-${i + 1}` : undefined)
      )
      const last = `node-${population - 1}`
      if (ending === 'missing') {
        chain[population - 1] = record(last, 'absent')
      }
      if (ending === 'cycle') {
        chain[population - 1] = record(last, 'node-0')
      }
      const candidate = reader(chain)
      let mapGets = 0
      let mapSets = 0
      let setAdds = 0
      const get = Map.prototype.get
      const set = Map.prototype.set
      const add = Set.prototype.add
      vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key
      ) {
        mapGets++
        return get.call(this, key)
      })
      vi.spyOn(Map.prototype, 'set').mockImplementation(function (
        this: Map<unknown, unknown>,
        key,
        value
      ) {
        mapSets++
        return set.call(this, key, value)
      })
      vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value) {
        setAdds++
        return add.call(this, value)
      })
      const resolve = createLineageRunningSessionResolver(candidate.store)
      let outputIds = 0
      let outputBytes = 0
      for (let i = 0; i < population; i++) {
        const result = resolve(`node-${i}`)
        outputIds += result.lineage.length
        outputBytes += Buffer.byteLength(JSON.stringify(result.lineage))
      }
      vi.restoreAllMocks()
      const nodes = population + Number(ending === 'missing')
      expect(candidate.reads.length).toBe(nodes)
      expect(mapSets).toBe(nodes)
      expect(mapGets).toBeLessThanOrEqual(outputIds + 5 * nodes)
      expect(setAdds).toBe(nodes + (ending === 'cycle' ? outputIds : 0))
      console.log('lineage acquisition operations', {
        population,
        ending,
        nodes,
        mapGets,
        mapSets,
        setAdds,
        outputIds,
        outputBytes
      })
      const fresh = reader(chain)
      expect(createLineageRunningSessionResolver(fresh.store)('node-0')).toEqual(resolve('node-0'))
      expect(fresh.reads.length).toBe(nodes)
    }
  }
})

it('uses installed-host production authority and custody with the same full result, lazy effects and fresh source boundaries', () => {
  const exercise = (
    captured: boolean,
    state:
      | 'live'
      | 'listed'
      | 'retired'
      | 'visibility-fault'
      | 'missing'
      | 'cycle'
      | 'remote'
      | 'uninstalled'
  ) => {
    let visibilityReads = 0
    const h = createSessionCallerHarness(hostRef, () => {
      visibilityReads++
      if (state === 'visibility-fault') {
        throw new Error('unreadable index')
      }
      return { present: true, sessionIds: state === 'listed' ? [SESSION_Y] : [] }
    })
    try {
      const root = h.records.get(SESSION_X)!
      const successor = h.records.get(SESSION_Y)!
      h.records.set(SESSION_X, {
        ...root,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          phase: 'committed',
          operationId: 'clear',
          callerKey: 'fixture',
          replacementSessionId: SESSION_Y
        }
      })
      h.records.set(SESSION_Y, {
        ...successor,
        provider: 'codex',
        lease: {
          ...successor.lease,
          claimStatus:
            state === 'listed' || state === 'retired' || state === 'visibility-fault'
              ? 'released'
              : 'live'
        },
        location: {
          ...successor.location,
          executionHostId: state === 'remote' ? 'ssh:box' : 'local'
        },
        ...(state === 'cycle'
          ? {
              conversationCommand: {
                command: 'clear' as const,
                state: 'completed' as const,
                phase: 'committed' as const,
                operationId: 'cycle',
                callerKey: 'fixture',
                replacementSessionId: SESSION_X
              }
            }
          : {})
      })
      if (state === 'missing') {
        h.records.delete(SESSION_Y)
      }
      const installed = getStructuredAgentSessionHost()!
      const reads = vi.spyOn(installed.deps.store, 'getConversation')
      if (state === 'uninstalled') {
        hostRef.current = null
      }
      const identity = structuredWorkerIdentities.register({
        handle: 'structworker_acquisition-fixture',
        sessionId: SESSION_X,
        agent: null,
        paneKey: 'session-fixture:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        processIncarnation: structuredWorkerProcessIncarnation(SESSION_X),
        worktreeId: 'workspace',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
      vi.mocked(h.runtime.getLiveTerminalPaneKey).mockRestore()
      const terminal = captured ? h.runtime.createTerminalIdentityReadContext() : undefined
      const context = terminal?.structured
      const result = structuredWorkerSession(identity, context)
      const hold = holdStructuredWorker(identity, h.db, undefined, context)
      const authority = resolveStructuredWorkerAuthority(identity.handle, h.db, context)
      const dispatchAuthority = h.runtime.getOrchestrationDispatchAuthority(
        identity.handle,
        terminal
      )
      const runtimeOutput = {
        process: h.runtime.getTerminalProcessIncarnation(identity.handle, terminal),
        pane: h.runtime.getTerminalPaneKey(identity.handle, terminal),
        authority: dispatchAuthority ? { ...dispatchAuthority, runtimeId: '<runtime>' } : null
      }
      const calls = reads.mock.calls.map(([id]) => id)
      // A new source generation must not retain the prior absence/location/failed suffix.
      hostRef.current = installed
      h.records.set(SESSION_Y, successor)
      const fresh = structuredWorkerSession(identity, createStructuredWorkerReadContext())
      return {
        result,
        runtimeOutput,
        hold,
        authority,
        fresh,
        calls,
        visibilityReads,
        registry: structuredWorkerIdentities.get(identity.handle)
      }
    } finally {
      h.close()
    }
  }
  for (const state of [
    'live',
    'listed',
    'retired',
    'visibility-fault',
    'missing',
    'cycle',
    'remote',
    'uninstalled'
  ] as const) {
    const baseline = exercise(false, state)
    const candidate = exercise(true, state)
    const { calls: originalCalls, visibilityReads: originalVisibility, ...expected } = baseline
    const { calls, visibilityReads, ...actual } = candidate
    expect(actual).toEqual(expected)
    expect(calls.length).toBeLessThanOrEqual(2)
    expect(visibilityReads).toBeLessThanOrEqual(1)
    if (state === 'live') {
      expect(visibilityReads).toBe(0)
    }
    console.log('installed authority acquisition', {
      state,
      originalCalls: originalCalls.length,
      calls: calls.length,
      originalVisibility,
      visibilityReads
    })
  }
})
