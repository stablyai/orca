import { expect, it, vi } from 'vitest'
import { internRecording, resolveRecording } from './golden-value-pool'

it('serializes each pooled value once for its hash and collision check', () => {
  const recording = {
    scenario: 'serialization',
    checkpoints: [
      {
        id: 'one',
        observation: {
          sender: [],
          payloads: [],
          settlements: {},
          state: { value: 'one' },
          effects: []
        }
      }
    ]
  }
  const stringify = vi.spyOn(JSON, 'stringify')
  try {
    const interned = internRecording(recording)
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    expect(calls).toBe(2)
    expect(resolveRecording(interned.values, interned.recording)).toEqual(recording)
  } finally {
    stringify.mockRestore()
  }
})
