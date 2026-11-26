// #49889: whom an old automation chat acts for is read on every turn read and bot close, and needs
// the existing automation of a run that landed in that chat. Guards the lookup: it indexes the run
// history and the automations once each (every change replaces the array), so later lookups read
// none of either however many there are. The tally counts each run and automation it reads.
import { expect, it } from 'vitest'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { findLiveAutomationOfRunChat } from './automation-run-chat-lookup'

/** Runs whose chat counts each time the lookup reads it. */
function counted(
  count: number,
  tally: { reads: number }
): Pick<AutomationRun, 'chatSessionId' | 'automationId'>[] {
  return Array.from({ length: count }, (_, index) => ({
    get chatSessionId() {
      tally.reads += 1
      return `chat-${index}`
    },
    automationId: `auto-${index % 7}`
  }))
}

it('reads each run and automation once per history, and none on later lookups, however many', () => {
  const lookups = (count: number) => {
    const tally = { reads: 0 }
    const automations = Array.from({ length: count / 10 }, (_, index) => ({
      get id() {
        tally.reads += 1
        return `auto-${index}`
      }
    }))
    const state = { automationRuns: counted(count, tally), automations }
    findLiveAutomationOfRunChat(state, 'chat-0')
    const first = tally.reads
    const found = Array.from({ length: 100 }, (_, index) =>
      findLiveAutomationOfRunChat(state, `chat-${index}`)
    )
    const missing = findLiveAutomationOfRunChat(state, 'gone')
    return { first, later: tally.reads - first, found: found[3], missing }
  }
  expect([lookups(1_000), lookups(10_000)]).toEqual([
    { first: 1_100, later: 0, found: 'auto-3', missing: null },
    { first: 11_000, later: 0, found: 'auto-3', missing: null }
  ])
})
