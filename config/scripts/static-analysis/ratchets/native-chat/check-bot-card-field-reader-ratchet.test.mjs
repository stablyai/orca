import { describe, expect, it } from 'vitest'
import { countCardFieldReads, readCardFields } from './check-bot-card-field-reader-ratchet.mjs'

const fields = readCardFields()
const reads = (source) => countCardFieldReads('probe.ts', source, fields)

describe('bot card field reader ratchet', () => {
  it.each([
    ['optional access', 'const a = block?.botRequest'],
    ['conditional access', 'const c = ok ? block.botRequest : null'],
    ['literal element access', "const b = block?.['botRequest']"],
    ['destructured declaration', 'const { botRequest } = block'],
    ['literal computed binding key', "const { ['botRequest']: value } = block"],
    ['destructuring assignment', 'let value; ({ botRequest: value } = block)'],
    ['shorthand destructuring assignment', 'let botRequest; ({ botRequest } = block)'],
    ['nested destructuring assignment', 'let value; [{ botRequest: value }] = blocks'],
    ['for-of destructuring head', 'let value; for ({ botRequest: value } of blocks) {}'],
    ['in check', "const d = 'toolAdded' in message"]
  ])('counts a %s', (_name, source) => {
    expect(reads(source)).toBe(1)
  })

  it.each([
    ['preload bridge', 'window.api.googleSetup.saveAppFile()'],
    ['object literal write', 'const card = { botRequest: request }'],
    ['assigned object literal', 'card = { botRequest: request }'],
    ['other field', 'const { text } = block']
  ])('ignores a %s', (_name, source) => {
    expect(reads(source)).toBe(0)
  })
})
