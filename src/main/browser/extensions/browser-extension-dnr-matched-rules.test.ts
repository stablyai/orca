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
  it("starts a tab over at each document, keeping the navigation's own matches", () => {
    const { matched } = tracker()
    matched.record(action(1), 3, null)
    matched.record(action(7, 'redirect'), 3, 7)
    expect(matched.matchedRules(EXT, { tabId: 3 }).map((info) => info.rule.ruleId)).toEqual([1])
    matched.commitNavigation(3)
    expect(matched.matchedRules(EXT, { tabId: 3 }).map((info) => info.rule.ruleId)).toEqual([7])
    expect(matched.actionCount(EXT, 3)).toBe(1)
  })

  it('filters by tab and time, and drops matches outside tabs after five minutes', () => {
    vi.useFakeTimers({ now: 1_000 })
    const { matched } = tracker()
    matched.record(action(1), -1, null)
    matched.record(action(2), 3, null)
    vi.setSystemTime(2_000)
    matched.record(action(3), 3, null)
    expect(matched.matchedRules(EXT, { minTimeStamp: 1_500 }).map((i) => i.rule.ruleId)).toEqual([
      3
    ])
    expect(matched.matchedRules(EXT, {}).map((i) => i.rule.ruleId)).toEqual([1, 2, 3])
    vi.setSystemTime(1_000 + 5 * 60_000)
    expect(matched.matchedRules(EXT, { tabId: -1 })).toEqual([])
  })

  it('does not restore historical feedback after revocation and regrant during navigation', () => {
    const options = { keeps: true }
    const { matched } = tracker(options)
    matched.record(action(1), 3, null)
    matched.record(action(2, 'redirect'), 3, 7)
    options.keeps = false
    matched.forgetMatches(EXT)
    options.keeps = true
    matched.commitNavigation(3)
    expect(matched.matchedRules(EXT, {})).toEqual([])
    expect(matched.actionCount(EXT, 3)).toBe(1)
    matched.record(action(3), 3, null)
    expect(matched.matchedRules(EXT, {}).map((info) => info.rule.ruleId)).toEqual([3])
  })
})
