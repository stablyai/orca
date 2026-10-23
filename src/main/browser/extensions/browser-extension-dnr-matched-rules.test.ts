import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DnrRequestAction } from './declarative-net-request/ruleset-matcher'
import { DnrMatchedRules } from './browser-extension-dnr-matched-rules'

const EXT = 'e'.repeat(32)

function action(ruleId: number, type: DnrRequestAction['type'] = 'block'): DnrRequestAction {
  return {
    type,
    rule: { extensionId: EXT, rulesetId: 'main', ruleId },
    indexPriority: 1,
    rulesetOrdinal: 1
  }
}

function tracker(options: { keeps?: boolean; displays?: boolean } = {}) {
  const shown: [number, number][] = []
  const matched = new DnrMatchedRules({
    keepsRules: () => options.keeps ?? true,
    displaysActionCount: () => options.displays ?? true,
    actionCountChanged: (_extensionId, tabId, count) => shown.push([tabId, count])
  })
  return { matched, shown }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('declarativeNetRequest matched rules', () => {
  it('counts actions but not allows, per tab, and shows the count only when displayed', () => {
    const hidden = tracker({ displays: false })
    hidden.matched.record(action(1), 3, false)
    hidden.matched.record(action(2, 'allow'), 3, false)
    expect(hidden.matched.actionCount(EXT, 3)).toBe(1)
    expect(hidden.shown).toEqual([])
    expect(hidden.matched.actionCounts(EXT)).toEqual([[3, 1]])

    const shown = tracker()
    shown.matched.record(action(1, 'redirect'), 3, false)
    shown.matched.record(action(1, 'modifyHeaders'), 4, false)
    shown.matched.record(action(1), -1, false)
    expect(shown.shown).toEqual([
      [3, 1],
      [4, 1]
    ])
  })

  it("starts a tab over at each document, keeping the navigation's own matches", () => {
    const { matched } = tracker()
    matched.record(action(1), 3, false)
    matched.record(action(7), 3, true)
    expect(matched.matchedRules(EXT, { tabId: 3 }).map((info) => info.rule.ruleId)).toEqual([1])
    matched.commitNavigation(3)
    expect(matched.matchedRules(EXT, { tabId: 3 }).map((info) => info.rule.ruleId)).toEqual([7])
    expect(matched.actionCount(EXT, 3)).toBe(1)
  })

  it('filters by tab and time, and drops matches outside tabs after five minutes', () => {
    vi.useFakeTimers({ now: 1_000 })
    const { matched } = tracker()
    matched.record(action(1), -1, false)
    matched.record(action(2), 3, false)
    vi.setSystemTime(2_000)
    matched.record(action(3), 3, false)
    expect(matched.matchedRules(EXT, { minTimeStamp: 1_500 }).map((i) => i.rule.ruleId)).toEqual([
      3
    ])
    expect(matched.matchedRules(EXT, {}).map((i) => i.rule.ruleId)).toEqual([1, 2, 3])
    vi.setSystemTime(1_000 + 5 * 60_000)
    expect(matched.matchedRules(EXT, { tabId: -1 })).toEqual([])
  })

  it('keeps no rule list for extensions that cannot read it', () => {
    const { matched } = tracker({ keeps: false })
    matched.record(action(1), 3, false)
    expect(matched.matchedRules(EXT, {})).toEqual([])
    expect(matched.actionCount(EXT, 3)).toBe(1)
  })

  it('lets the extension adjust the count, never below zero', () => {
    const { matched, shown } = tracker()
    matched.incrementActionCount(EXT, 3, 4)
    matched.incrementActionCount(EXT, 3, -10)
    expect(shown).toEqual([
      [3, 4],
      [3, 0]
    ])
  })
})
