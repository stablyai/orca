import { vi } from 'vitest'
import * as cut from '../../shared/native-chat/native-chat-orca-stop-cut'
import * as commands from '../../shared/structured-agent-session-command-entry'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session-journal-types'

/** Count only the original status reader, after production context selection. */
export function countStatusCutWork() {
  const counts = {
    calls: 0,
    items: 0,
    submissions: 0,
    pending: 0,
    bodyEntries: 0,
    commandVisits: 0,
    backward: 0,
    scoped: 0,
    indexes: 0,
    commandEntries: 0
  }
  let reading = false
  const index = commands.structuredAgentSessionCommandTurnItemIds
  vi.spyOn(commands, 'structuredAgentSessionCommandTurnItemIds').mockImplementation((items) => {
    const result = index(items)
    if (reading) {
      counts.indexes++
      counts.commandEntries += result.size
    }
    return result
  })
  function watchItems(items: readonly AgentJournalRenderItem[]) {
    let iterators = 0
    return new Proxy(items, {
      get(target, property) {
        if (property === 'map') {
          return function map<U>(
            callback: (
              item: AgentJournalRenderItem,
              i: number,
              rows: readonly AgentJournalRenderItem[]
            ) => U,
            thisArg?: unknown
          ) {
            return target.map((item, i, rows) => {
              counts.bodyEntries++
              return callback.call(thisArg, item, i, rows)
            })
          }
        }
        if (property === Symbol.iterator) {
          return function* (): Generator<AgentJournalRenderItem, undefined> {
            const phase = iterators++ === 0 ? 'commandVisits' : 'scoped'
            for (const item of target) {
              counts[phase]++
              yield item
            }
            return undefined
          }
        }
        if (property === 'length') {
          return target.length
        }
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          const index = Number(property)
          if (Number.isSafeInteger(index)) {
            counts.backward++
            return target[index]
          }
        }
        throw new Error(`Uncounted status-cut item property: ${String(property)}`)
      }
    })
  }
  function watchSubmissions(submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]) {
    return new Proxy(submissions, {
      get(target, property) {
        if (property === 'some') {
          return (predicate: Parameters<typeof target.some>[0], thisArg?: unknown) =>
            target.some((item, i, rows) => {
              counts.pending++
              return predicate.call(thisArg, item, i, rows)
            })
        }
        throw new Error(`Uncounted status-cut submission property: ${String(property)}`)
      }
    })
  }
  const outcome = cut.nativeChatStatusTurnOutcome
  vi.spyOn(cut, 'nativeChatStatusTurnOutcome').mockImplementation((request, items, submissions) => {
    counts.calls++
    counts.items += items.length
    counts.submissions += submissions.length
    reading = true
    try {
      return outcome(request, watchItems(items), watchSubmissions(submissions))
    } finally {
      reading = false
    }
  })
  return counts
}
