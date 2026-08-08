import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('localization package scripts', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts

  it('keeps safe catalog and extraction verification available', () => {
    expect(scripts['verify:localization-catalog']).toBeDefined()
    expect(scripts['sync:localization-catalog']).toBeDefined()
    expect(scripts['verify:localization-extraction']).toBeDefined()
  })

  it('does not expose whole-catalog translation and repair commands', () => {
    expect(scripts['bootstrap:locale-catalog']).toBeUndefined()
    expect(scripts['bootstrap:zh-catalog']).toBeUndefined()
    expect(scripts['bootstrap:ko-catalog']).toBeUndefined()
    expect(scripts['bootstrap:ja-catalog']).toBeUndefined()
    expect(scripts['bootstrap:es-catalog']).toBeUndefined()
    expect(scripts['repair:locale-catalog']).toBeUndefined()
  })
})
