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
  ['different object', { ...OTHER }],
  ['different path', { ...META, path: '/chats/b/meta.json' }],
  ['different size', { ...META, sizeBytes: 21 }]
]

// entry (row) x observed (column). A `true` cell is a cache hit.
const TRUTH_TABLE: Record<string, Record<string, boolean>> = {
  undefined: {
    undefined: true,
    "'none'": true,
    "'unknown'": false,
    'same object': false,
    'different object': false,
    'different path': false,
    'different size': false
  },
  "'none'": {
    undefined: true,
    "'none'": true,
    "'unknown'": false,
    'same object': false,
    'different object': false,
    'different path': false,
    'different size': false
  },
  "'unknown'": {
    undefined: false,
    "'none'": false,
    "'unknown'": false,
    'same object': false,
    'different object': false,
    'different path': false,
    'different size': false
  },
  object: {
    undefined: false,
    "'none'": false,
    "'unknown'": false,
    'same object': true,
    'different object': false,
    'different path': false,
    'different size': false
  }
}

describe.each(ENTRIES)('cached %s', (entryLabel, entry) => {
  it.each(OBSERVED)(`vs observed %s`, (observedLabel, observed) => {
    expect(sidecarUnchanged(entry, observed)).toBe(TRUTH_TABLE[entryLabel][observedLabel])
  })
})
