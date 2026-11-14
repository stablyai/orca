import { describe, expect, it, vi } from 'vitest'
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
  it("refreshes a fork's divider when its source's own source is renamed", () => {
    const marker = {
      forkedFrom: link('parent', true)!,
      sourceName: 'Annotate',
      sourceForked: true,
      sourceMissing: false,
      sourceParentId: 'root'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refresh is spied, so delivery fields are never read.
    const subscriber = { sessionId: 'child', readForkMarker: () => marker } as unknown as Subscriber
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refresh is spied, so the journal is never read.
    const journal = {} as AgentSessionJournal
    const markers = new ForkMarkerSubscriptions(
      vi.fn(),
      () => [subscriber],
      () => 0,
      () => journal
    )
    const refresh = vi.spyOn(markers, 'refresh').mockImplementation(() => {})
    markers.add(subscriber)
    markers.refreshSources(() => journal, ['root'])
    markers.refreshSources(() => journal, ['unrelated'])
    markers.delete(subscriber)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
