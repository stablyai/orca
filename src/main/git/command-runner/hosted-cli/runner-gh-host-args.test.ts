import { describe, expect, it } from 'vitest'

import { collectGhArgvHostSignals } from './gh-host-args'

describe('collectGhArgvHostSignals', () => {
  it('reads the attached -R forms gh accepts, so a bound call cannot drift hosts through them', () => {
    expect(collectGhArgvHostSignals(['pr', 'list', '-Rghe.example.com/a/b'])).toEqual([
      'ghe.example.com'
    ])
    expect(collectGhArgvHostSignals(['pr', 'list', '-R=ghe.example.com/a/b'])).toEqual([
      'ghe.example.com'
    ])
  })
})
