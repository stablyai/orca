import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('localization package scripts', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts

  it('keeps safe catalog and extraction verification available', () => {
    expect(scripts['verify:localization-catalog']).toBeDefined()
    expect(scripts['sync:localization-catalog']).toBeDefined()
    expect(scripts['verify:localization-extraction']).toBeDefined()
    expect(scripts['verify:localization-repair']).toBeDefined()
  })

  it('does not expose whole-catalog translation and repair commands', () => {
    expect(scripts['bootstrap:locale-catalog']).toBeUndefined()
    expect(scripts['bootstrap:zh-catalog']).toBeUndefined()
    expect(scripts['bootstrap:ko-catalog']).toBeUndefined()
    expect(scripts['bootstrap:ja-catalog']).toBeUndefined()
    expect(scripts['bootstrap:es-catalog']).toBeUndefined()
    // Mutating repair stays offline-only; CI uses verify:localization-repair (check, not write).
    expect(scripts['repair:locale-catalog']).toBeUndefined()
  })
})
