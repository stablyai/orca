import { expect, it } from 'vitest'
import { CodexTurnOrdinals, MAX_CODEX_TURN_ORDINAL_ENTRIES } from './codex-turn-ordinals'

it('retains ordinal continuity on late reactivation and evicts oldest forgotten turns', () => {
  const ordinals = new CodexTurnOrdinals()
  expect(ordinals.ordinalFor('t', 'first', 'a')).toBe(0)
  ordinals.forgetTurn('t', 'first')
  expect(ordinals.ordinalFor('t', 'first', 'b')).toBe(1)
  expect(ordinals.forgottenTurnCount).toBe(0)
  ordinals.forgetTurn('t', 'first')
  for (let index = 0; index < MAX_CODEX_TURN_ORDINAL_ENTRIES; index += 1) {
    ordinals.ordinalFor('t', String(index), 'a')
    ordinals.forgetTurn('t', String(index))
  }
  expect(ordinals.forgottenTurnCount).toBe(MAX_CODEX_TURN_ORDINAL_ENTRIES)
  expect(ordinals.ordinalFor('t', 'first', 'c')).toBe(0)
})
