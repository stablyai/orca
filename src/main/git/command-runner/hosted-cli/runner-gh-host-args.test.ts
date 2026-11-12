import { describe, expect, it } from 'vitest'

import { applyGhHostToArgs, collectGhArgvHostSignals } from './gh-host-args'

describe('applyGhHostToArgs', () => {
  it('does not rewrite free-text flag values that merely start with -R', () => {
    expect(
      applyGhHostToArgs(
        ['pr', 'edit', '7', '--title', '-Refactor foo/bar', '--repo', 'a/b'],
        'github.acme-corp.com'
      )
    ).toEqual([
      'pr',
      'edit',
      '7',
      '--title',
      '-Refactor foo/bar',
      '--repo',
      'github.acme-corp.com/a/b'
    ])
  })
})

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
