import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('locale-ko-key-overrides', () => {
  it('keeps Korean key override data scoped to Korean values', () => {
    const overrides = JSON.parse(
      fs.readFileSync(new URL('./locale-ko-key-overrides.json', import.meta.url), 'utf8')
    )
    for (const value of Object.values(overrides)) {
      expect(Object.keys(value)).toEqual(['ko'])
    }
  })
})
