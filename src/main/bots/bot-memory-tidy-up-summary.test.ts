import { describe, expect, it } from 'vitest'
import { type TidyUpPlan, tidyUpSummaryOf } from './bot-memory-tidy-up-draft'

const COPIES = 150
const copies = (text: string) =>
  Array.from({ length: COPIES }, (_, index) => ({
    line: `- 2026-10-${String((index % 28) + 1).padStart(2, '0')} ${text} · from: Slack ${index}`,
    after: null
  }))

describe("a tidy-up's summary", () => {
  it('names a fact once however many raw copies MEMORY.md gave up or took', () => {
    const plan: TidyUpPlan = {
      change: { added: [], removed: [] },
      kept: new Map(),
      topics: new Map([['deploys', ['- deploys run on friday']]]),
      filed: new Set(['deploys run on friday']),
      replaced: new Set(['the cat is grey'])
    }
    const made = {
      added: copies('the cat is black'),
      removed: [
        ...copies('the cat is grey'),
        ...copies('deploys run on friday'),
        ...copies('an old note')
      ]
    }

    expect(tidyUpSummaryOf(plan, made, made, new Map())).toEqual({
      learned: ['the cat is black'],
      replaced: ['the cat is grey'],
      filed: [{ topic: 'deploys', count: 1 }],
      moved: 1,
      merged: 0
    })
  })
})
