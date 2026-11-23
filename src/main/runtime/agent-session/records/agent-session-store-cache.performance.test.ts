import { expect, it } from 'vitest'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import { notifyAgentSessionStoreCacheChanges } from './agent-session-store-cache'

type Notify = Parameters<typeof notifyAgentSessionStoreCacheChanges>

/** A chat-tab table of `count` sessions that counts every read of it. */
function countedTabs(count: number, moved: string | null, reads: { count: number }) {
  const ids = Array.from({ length: count }, (_, index) => `session-${index}`)
  return {
    sessionIds: () => {
      reads.count += ids.length
      return ids
    },
    tabIdFor: (id: string) => {
      reads.count += 1
      return id === moved ? 'moved-tab' : `tab-${id}`
    }
  }
}

it.each([100, 1_000])(
  'a chat-tab membership change among %i tabs builds no scope with nobody listening, one address with a listener',
  (count) => {
    const reads = { count: 0 }
    const state = (moved: string | null) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notifier reads only records and the tab table.
      ({
        records: new Map(),
        sessionTabs: countedTabs(count, moved, reads)
      }) as unknown as Notify[0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a tab-table write with no record rows.
    const writes = { sessionTabs: {}, records: { remove: [], upsert: [] } } as unknown as Notify[2]

    notifyAgentSessionStoreCacheChanges(state(null), state('session-0'), writes)
    expect(reads.count).toBe(0)

    const notices: string[][] = []
    const stop = sessionCrewChanges.subscribe((facets) => {
      notices.push([...(facets.recordIds ?? [])])
    })
    notifyAgentSessionStoreCacheChanges(state(null), state('session-0'), writes)
    stop()
    expect(notices).toEqual([['session-0']])
  }
)
