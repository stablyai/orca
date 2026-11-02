import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { sessionRecord } from '../rpc/orchestration-session-caller-test-fixture'
import {
  createLineageRunningSessionResolver,
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

function reader(records: readonly AgentSessionConversationView[]) {
  const byId = new Map(records.map((value) => [value.sessionId, value]))
  const reads: string[] = []
  const store: AgentSessionRecordReader = {
    getRecord: (id) => {
      reads.push(id)
      return byId.get(id) ?? null
    },
    listRecords: () => {
      throw new Error('unrelated inventory must not be acquired')
    }
  }
  return { store, reads }
}

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
      for (let i = 0; i < population; i++) {
        const result = resolve(`node-${i}`)
        outputIds += result.lineage.length
      }
      vi.restoreAllMocks()
      const nodes = population + Number(ending === 'missing')
      expect(candidate.reads.length).toBe(nodes)
      expect(mapSets).toBe(nodes)
      expect(mapGets).toBeLessThanOrEqual(outputIds + 5 * nodes)
      expect(setAdds).toBe(nodes + (ending === 'cycle' ? outputIds : 0))
      const fresh = reader(chain)
      expect(createLineageRunningSessionResolver(fresh.store)('node-0')).toEqual(resolve('node-0'))
      expect(fresh.reads.length).toBe(nodes)
    }
  }
})
