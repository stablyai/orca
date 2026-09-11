import { describe, expect, it } from 'vitest'
import { sidecarUnchanged, type SessionSidecarObservation } from './session-sidecar-stat'

const META = { path: '/chats/a/meta.json', mtimeMs: 100, sizeBytes: 20 } as const
const OTHER = { path: '/chats/a/meta.json', mtimeMs: 101, sizeBytes: 20 } as const

type Named = [label: string, value: SessionSidecarObservation | undefined]

const ENTRIES: Named[] = [
  ['undefined', undefined],
  ["'none'", 'none'],
  ["'unknown'", 'unknown'],
  ['object', { ...META }]
]
const OBSERVED: Named[] = [
  ['undefined', undefined],
  ["'none'", 'none'],
  ["'unknown'", 'unknown'],
  ['same object', { ...META }],
  ['different object', { ...OTHER }]
]

// entry (row) x observed (column). A `true` cell is a cache hit.
const TRUTH_TABLE: Record<string, Record<string, boolean>> = {
  undefined: {
    undefined: true,
    "'none'": true,
    "'unknown'": false,
    'same object': false,
    'different object': false
  },
  "'none'": {
    undefined: true,
    "'none'": true,
    "'unknown'": false,
    'same object': false,
    'different object': false
  },
  "'unknown'": {
    undefined: false,
    "'none'": false,
    "'unknown'": false,
    'same object': false,
    'different object': false
  },
  object: {
    undefined: false,
    "'none'": false,
    "'unknown'": false,
    'same object': true,
    'different object': false
  }
}

describe.each(ENTRIES)('cached %s', (entryLabel, entry) => {
  it.each(OBSERVED)(`vs observed %s`, (observedLabel, observed) => {
    expect(sidecarUnchanged(entry, observed)).toBe(TRUTH_TABLE[entryLabel][observedLabel])
  })
})

it('treats a vanished sidecar as a change, not as "never had one"', () => {
  expect(sidecarUnchanged({ ...META }, 'none')).toBe(false)
})

it('never concludes anything from an unreadable sidecar, in either position', () => {
  expect(sidecarUnchanged('unknown', 'none')).toBe(false)
  expect(sidecarUnchanged('unknown', { ...META })).toBe(false)
  expect(sidecarUnchanged({ ...META }, 'unknown')).toBe(false)
})

it('keeps an agent with no sidecar at all a cache hit', () => {
  expect(sidecarUnchanged(undefined, undefined)).toBe(true)
  expect(sidecarUnchanged(undefined, 'none')).toBe(true)
})
