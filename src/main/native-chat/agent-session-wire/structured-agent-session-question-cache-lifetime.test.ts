import { afterEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  IDLE_MS,
  sweepOnce,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { heldStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import { messageQuestionSourceId } from '../message-question-source'
import { messageQuestionsFor } from '../message-question-repository'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

let rig: RestTestRig | undefined
type CacheLifetimeObservation = {
  count: number
  bytes: number
  startedAt: number
  phaseStartedAt: number
  phase: string
  iteration: number
  completedIterations: number
  recent: { phase: string; iteration: number; elapsedMs: number }[]
}
let observation: CacheLifetimeObservation | undefined
afterEach(async () => {
  const cleanupStartedAt = Date.now()
  let cleanupCompleted = false
  console.info(
    'question-cache-lifetime-observation',
    JSON.stringify({
      ...observation,
      elapsedMs: observation && Date.now() - observation.startedAt,
      phaseElapsedMs: observation && Date.now() - observation.phaseStartedAt,
      cleanup: 'start'
    })
  )
  try {
    await rig?.dispose()
    rig = undefined
    vi.restoreAllMocks()
    cleanupCompleted = true
  } finally {
    console.info(
      'question-cache-lifetime-observation',
      JSON.stringify({
        ...observation,
        elapsedMs: observation && Date.now() - observation.startedAt,
        cleanup: 'ended',
        cleanupCompleted,
        cleanupElapsedMs: Date.now() - cleanupStartedAt
      })
    )
    observation = undefined
  }
})

it.each([10, 100].flatMap((count) => [1000, 10000].map((bytes) => ({ count, bytes }))))(
  'releases full occurrence memory after $count actual idle evictions with $bytes-byte definitions and reloads saved outcomes',
  async ({ count, bytes }) => {
    const progress: CacheLifetimeObservation = {
      count,
      bytes,
      startedAt: Date.now(),
      phaseStartedAt: Date.now(),
      phase: 'create-rig',
      iteration: -1,
      completedIterations: 0,
      recent: []
    }
    observation = progress
    const phase = (next: string, iteration = progress.iteration) => {
      const now = Date.now()
      progress.recent.push({
        phase: progress.phase,
        iteration: progress.iteration,
        elapsedMs: now - progress.phaseStartedAt
      })
      if (progress.recent.length > 8) {
        progress.recent.shift()
      }
      progress.phase = next
      progress.iteration = iteration
      progress.phaseStartedAt = now
    }
    rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    const current = rig
    const sessionIds = ['live-sibling', ...Array.from({ length: count }, (_, i) => `at-rest-${i}`)]
    phase('seed-and-open-store')
    await seedTestAgentSessionRecordStore(current.root, {
      records: sessionIds.map((sessionId) =>
        agentSessionRecordFixture({
          sessionId,
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/private-fixture' }
        })
      )
    })
    const store = await openTestAgentSessionRecordStore(current.root)
    current.store = store
    await current.host.flushAllStreamedEvents()
    current.host = new StructuredAgentSessionHost({ ...current.host.deps, store })
    const { host } = current
    const sessions = host.collaboratorsForTests().sessions
    const repository = messageQuestionsFor(host.deps.journalDatabase)
    const retained = repository['sources']
    const retainedBytes = () =>
      [...retained.values()].reduce(
        (total, source) =>
          total + [...source.json.values()].reduce((sum, json) => sum + Buffer.byteLength(json), 0),
        0
      )
    const open = async (sessionId: string) => {
      expect(await host.history({ sessionId, direction: 'tail' })).toMatchObject({ ok: true })
      const session = sessions.get(sessionId)
      if (!session) {
        throw new Error('Expected actual opened conversation')
      }
      const work = () =>
        heldStructuredAgentSessionCurrentWork(store, sessionId, session.journal, session)
      const publish = () => {
        const payload = work().requestProjection(
          sessionId,
          'agent-session.current-requests.v2'
        ).items
        if (!payload || Array.isArray(payload) || payload.asyncQuestions === null) {
          throw new Error('Expected full occurrence publication')
        }
        return payload
      }
      return { session, publish }
    }
    const append = async (sessionId: string, ordinal: number, question = true) => {
      const journal = sessions.get(sessionId)!.journal
      const body = question ? asyncQuestionBody(`call-${ordinal}`) : undefined
      await journal.appendItem(
        { provider: 'codex', threadId: sessionId, turnId: 'questions', ordinal },
        body
          ? {
              ...body,
              blocks: body.blocks.map((block) =>
                block.type === 'tool-call'
                  ? {
                      ...block,
                      input: { questions: [{ title: 'Full value', options: ['x'.repeat(bytes)] }] }
                    }
                  : block
              )
            }
          : { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'delivered answer' }] },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const sibling = await open('live-sibling')
    phase('sibling-definition')
    await append('live-sibling', 0)
    const siblingPayload = sibling.publish()
    expect(siblingPayload.asyncQuestions).toHaveLength(1)
    const siblingBytes = retainedBytes()
    expect(siblingBytes).toBeGreaterThan(bytes)
    const read = vi.spyOn(host.deps.journalDatabase.db, 'prepare')
    let previous: ReturnType<typeof repository.current> | undefined
    for (const sessionId of sessionIds.slice(1)) {
      phase('open-session', progress.iteration + 1)
      const { session, publish } = await open(sessionId)
      phase('first-question-and-publication')
      await append(sessionId, 0)
      expect(publish().asyncQuestions).toHaveLength(1)
      phase('delivery-and-publication')
      await append(sessionId, 1, false)
      expect(publish().asyncQuestions).toHaveLength(0)
      phase('two-definitions-and-publication')
      await append(sessionId, 2)
      await append(sessionId, 3)
      const ids = publish().asyncQuestions!.map((record) => record.id)
      expect(ids).toHaveLength(2)
      phase('cancel-and-saved-outcomes')
      await host.cancelCurrentQuestions({ sessionId, ids: [ids[0]] }, 'phone')
      expect(publish().asyncQuestions).toHaveLength(1)
      const owner = session.journal.messageQuestions()
      previous = repository.current(owner.source)
      expect(previous.records.map((record) => record.resolution.state)).toEqual([
        'resolved',
        'cancelled',
        'pending'
      ])
      expect(retained.size).toBe(2)
      expect(retainedBytes()).toBeGreaterThan(siblingBytes + 3 * bytes)
      current.clock.now += IDLE_MS + 1
      sessions.touch('live-sibling')
      phase('idle-eviction')
      await sweepOnce(host)
      phase('eviction-retention-and-sibling-assertions')
      expect(host.hasSession(sessionId)).toBe(false)
      expect(retained.has(messageQuestionSourceId(owner.source))).toBe(false)
      expect(retained.size).toBe(1)
      expect(retainedBytes()).toBe(siblingBytes)
      expect(sibling.publish()).toBe(siblingPayload)
      progress.completedIterations++
    }
    phase('reopen-and-saved-outcomes')
    const loadsBefore = read.mock.calls.filter(([sql]) =>
      sql.includes('SELECT occurrence_id, record_json')
    ).length
    const reopened = await open(sessionIds.at(-1)!)
    expect(reopened.publish().asyncQuestions).toHaveLength(1)
    const saved = repository.current(reopened.session.journal.messageQuestions().source)
    expect(saved).not.toBe(previous)
    expect(saved.records.map((record) => record.resolution.state)).toEqual([
      'resolved',
      'cancelled',
      'pending'
    ])
    expect(
      read.mock.calls.filter(([sql]) => sql.includes('SELECT occurrence_id, record_json')).length
    ).toBeGreaterThan(loadsBefore)
    expect(sibling.publish()).toBe(siblingPayload)
    expect(current.adapter.acquire).not.toHaveBeenCalled()
    expect(current.adapter.dispatch).not.toHaveBeenCalled()
    phase('flush-all')
    await host.flushAllStreamedEvents()
    phase('final-zero-retention')
    expect(retained.size).toBe(0)
    expect(retainedBytes()).toBe(0)
    phase('assertions-complete')
  },
  30_000
)
