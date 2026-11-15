import { describe, expect, it } from 'vitest'
import { projectForkMarker, readForkMarker, FORK_MARKER_ITEM_ID } from './agent-session-fork-marker'
import { ForkMarkerSubscriptions } from '../subscribers/agent-session-fork-marker-delivery'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { Subscriber } from '../subscribers/agent-session-subscribe-input'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'

type NamedRecord = Pick<
  AgentSessionRecord,
  'sessionId' | 'provider' | 'conversationName' | 'conversationNameSource' | 'forkedFrom'
>

function store(...records: NamedRecord[]) {
  const byId = new Map(records.map((record) => [record.sessionId, record]))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the marker reads only these naming fields.
  return { getRecord: (id: string) => (byId.get(id) as AgentSessionRecord | undefined) ?? null }
}

const link = (sessionId: string, plainName?: true): NamedRecord['forkedFrom'] => ({
  sessionId,
  itemId: 'response',
  childBoundary: { kind: 'start' },
  ...(plainName ? { plainName } : {})
})

describe('readForkMarker', () => {
  it('names an older fork source by its shown name and says it is a fork', () => {
    const marker = readForkMarker(
      store(
        { sessionId: 'root', provider: 'codex', conversationName: 'Annotate' },
        {
          sessionId: 'parent',
          provider: 'codex',
          conversationName: 'Annotate fork',
          forkedFrom: link('root')
        },
        { sessionId: 'child', provider: 'codex', forkedFrom: link('parent', true) }
      ),
      'child'
    )
    expect(marker).toMatchObject({
      sourceName: 'Annotate',
      sourceForked: true,
      sourceMissing: false,
      sourceParentId: 'root'
    })
  })

  it('reports a source this host has no record of', () => {
    expect(
      readForkMarker(
        store({ sessionId: 'child', provider: 'codex', forkedFrom: link('gone', true) }),
        'child'
      )
    ).toMatchObject({ sourceName: 'another chat', sourceForked: false, sourceMissing: true })
  })
})

describe('projectForkMarker', () => {
  it('re-projects when only the source fork state changes', () => {
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'child',
      cursor: { epoch: 'e', sequence: 0 },
      submissions: [],
      items: []
    }
    const forkedFrom = link('parent', true)!
    const base = { forkedFrom, sourceName: 'Annotate', sourceMissing: false }
    projectForkMarker(snapshot, { ...base, sourceForked: false })
    const row = projectForkMarker(snapshot, { ...base, sourceForked: true }).items.find(
      (item) => item.itemId === FORK_MARKER_ITEM_ID
    )
    expect(row?.body).toMatchObject({ forkedFrom: { sessionId: 'parent', sourceForked: true } })
  })
})

describe('ForkMarkerSubscriptions', () => {
  it("re-delivers a fork's divider when its source's own source is renamed", async () => {
    const root: NamedRecord = { sessionId: 'root', provider: 'codex', conversationName: 'Annotate' }
    const records = store(
      root,
      {
        sessionId: 'parent',
        provider: 'codex',
        conversationName: 'Annotate fork',
        forkedFrom: link('root')
      },
      { sessionId: 'child', provider: 'codex', forkedFrom: link('parent', true) }
    )
    const emitted: unknown[] = []
    const fields = {
      sessionId: 'child',
      boundedFrames: false,
      cursor: { epoch: 'e', sequence: 0 },
      fence: 1,
      readForkMarker: () => readForkMarker(records, 'child')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: marker delivery reads only these subscriber fields.
    const subscriber = fields as unknown as Subscriber
    subscriber.forkMarkerView = JSON.stringify(subscriber.readForkMarker?.())
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'child',
      cursor: { epoch: 'e', sequence: 0 },
      submissions: [],
      items: []
    }
    const journalFields = {
      identity: { sessionId: 'child' },
      cursor: () => snapshot.cursor,
      reads: { forkMarkerGroup: async () => snapshot }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: marker delivery reads only these journal members.
    const journal = journalFields as unknown as AgentSessionJournal
    const deliveries: Promise<void>[] = []
    const port = {
      isActive: () => true,
      emit: async (_target: Subscriber, event: unknown) => {
        emitted.push(event)
      }
    }
    const markers: ForkMarkerSubscriptions = new ForkMarkerSubscriptions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery calls only isActive and emit.
      () => port as never,
      () => [subscriber],
      () => 0,
      () => journal,
      (target, read) => deliveries.push(markers.refresh(target, read))
    )
    markers.add(subscriber)

    // The parent's older " fork" title no longer matches, so its shown name becomes its saved one.
    root.conversationName = 'Annotate v2'
    markers.refreshSources(() => journal, ['root'])
    markers.refreshSources(() => journal, ['unrelated'])
    await Promise.all(deliveries)
    markers.delete(subscriber)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'batch',
      batch: {
        items: [
          {
            itemId: FORK_MARKER_ITEM_ID,
            body: {
              text: 'Forked from Annotate fork',
              forkedFrom: { sessionId: 'parent', sourceForked: true }
            }
          }
        ]
      }
    })
  })
})
