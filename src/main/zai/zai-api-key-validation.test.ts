import { describe, expect, it } from 'vitest'
import { MAX_ZAI_API_KEY_BYTES, validateZaiApiKey } from './zai-api-key-validation'

describe('validateZaiApiKey', () => {
  it('trims and accepts printable Latin-1 input', () => {
    expect(validateZaiApiKey('  caféÿ  ')).toBe('caféÿ')
  })

  it('rejects empty input after trimming', () => {
    expect(() => validateZaiApiKey('   ')).toThrow(/required/i)
  })

  it('rejects oversized input by utf-8 byte length', () => {
    expect(() => validateZaiApiKey('a'.repeat(MAX_ZAI_API_KEY_BYTES + 1))).toThrow(/at most/i)
  })

  it.each(['abc\nxyz', 'abc\rxyz', `abc${String.fromCharCode(0x7f)}xyz`])(
    'rejects control characters in %j',
    (value) => {
      expect(() => validateZaiApiKey(value)).toThrow(/control characters/i)
    }
  )

  it.each(['claveĀ', 'clave正常', 'clave🔐'])(
    'rejects characters outside Latin-1 in %j',
    (value) => {
      expect(() => validateZaiApiKey(value)).toThrow(/HTTP headers/i)
    }
  )
})
