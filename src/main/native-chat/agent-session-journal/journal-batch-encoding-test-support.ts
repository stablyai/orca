import { expect } from 'vitest'

/** Count canonical serialization separately from bounded packet-envelope serialization. */
export function journalBatchEncodingWork(inputs: readonly unknown[]) {
  let packets = 0,
    outcomePackets = 0,
    values = 0
  for (const input of inputs) {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('effect' in input) ||
      !('index' in input)
    ) {
      continue
    }
    packets++
    const effect = input.effect
    if (
      typeof effect === 'object' &&
      effect !== null &&
      'kind' in effect &&
      effect.kind === 'outcomes' &&
      'values' in effect &&
      Array.isArray(effect.values)
    ) {
      outcomePackets++
      values += effect.values.length
      expect(effect.values.length).toBeLessThanOrEqual(128)
    }
  }
  expect(outcomePackets).toBe(1 + Math.ceil(values / 128))
  return { calls: inputs.length - packets, otherPackets: packets - outcomePackets }
}
