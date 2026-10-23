/// <reference types="chrome" />
import { describe, expect, it } from 'vitest'
import {
  matchesDiscardedTabNativeQuery,
  matchesOrcaTabQuery,
  type OrcaTabQuery
} from './browser-extension-tab-query'

const MAIN = 1
const POPOUT = 7

function tab(overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    id: 10,
    index: 0,
    windowId: MAIN,
    active: false,
    highlighted: false,
    selected: false,
    pinned: false,
    discarded: false,
    autoDiscardable: true,
    incognito: false,
    groupId: -1,
    status: 'complete',
    ...overrides
  }
}

const tabs = [
  tab({ id: 10, index: 0 }),
  tab({ id: 11, index: 1, active: true, highlighted: true, status: 'loading' }),
  tab({ id: 20, index: 0, windowId: POPOUT, active: true, highlighted: true }),
  tab({ id: 30, index: 2, discarded: true, status: 'unloaded' })
]

function query(q: OrcaTabQuery, callerWindowId: number | null = MAIN): (number | undefined)[] {
  const context = {
    callerWindowId,
    lastFocusedWindowId: MAIN,
    windowTypeById: new Map([
      [MAIN, 'normal'],
      [POPOUT, 'popup']
    ])
  }
  return tabs.filter((t) => matchesOrcaTabQuery(t, q, context)).map((t) => t.id)
}

describe('matchesOrcaTabQuery', () => {
  it('answers the common "active tab in my window" query per caller window', () => {
    expect(query({ active: true, currentWindow: true })).toEqual([11])
    expect(query({ active: true, currentWindow: true }, POPOUT)).toEqual([20])
    expect(query({ active: true, lastFocusedWindow: true }, POPOUT)).toEqual([11])
  })

  it('resolves WINDOW_ID_CURRENT and window types', () => {
    expect(query({ windowId: -2 }, POPOUT)).toEqual([20])
    expect(query({ windowType: 'normal' })).toEqual([10, 11, 30])
    expect(query({ currentWindow: false })).toEqual([20])
  })

  it('filters status and index, and never matches pinned or grouped tabs', () => {
    expect(query({ status: 'loading' })).toEqual([11])
    expect(query({ status: 'unloaded' })).toEqual([30])
    expect(query({ discarded: true })).toEqual([30])
    expect(query({ discarded: false, index: 0 })).toEqual([10, 20])
    expect(query({ index: 0 })).toEqual([10, 20])
    expect(query({ pinned: true })).toEqual([])
    expect(query({ groupId: 3 })).toEqual([])
  })
})

describe('matchesDiscardedTabNativeQuery', () => {
  const cold = tab({ id: 30, discarded: true, url: 'https://docs.test/a', title: 'Docs: A' })

  it("applies Electron's url and title patterns to the tab's saved address", () => {
    expect(matchesDiscardedTabNativeQuery(cold, { url: '*://docs.test/*' })).toBe(true)
    expect(matchesDiscardedTabNativeQuery(cold, { url: ['https://x.test/*', '<all_urls>'] })).toBe(
      true
    )
    expect(matchesDiscardedTabNativeQuery(cold, { url: 'https://x.test/*' })).toBe(false)
    expect(matchesDiscardedTabNativeQuery(cold, { title: 'Docs: *' })).toBe(true)
    expect(matchesDiscardedTabNativeQuery(cold, { title: 'docs*' })).toBe(false)
  })

  it('never matches a hidden url, sound or a mute', () => {
    const hidden = tab({ id: 31, discarded: true })
    expect(matchesDiscardedTabNativeQuery(hidden, { url: '<all_urls>' })).toBe(false)
    expect(matchesDiscardedTabNativeQuery(cold, { audible: true })).toBe(false)
    expect(matchesDiscardedTabNativeQuery(cold, { muted: true })).toBe(false)
    expect(matchesDiscardedTabNativeQuery(cold, { audible: false, muted: false })).toBe(true)
  })
})
